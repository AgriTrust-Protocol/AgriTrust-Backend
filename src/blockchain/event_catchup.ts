import { Pool } from 'pg';
import { SorobanBridge } from './soroban_bridge';
import { EventProcessor } from './event_processor';
import { v4 as uuidv4 } from 'uuid';

interface LedgerGap {
  rangeStart: number;
  rangeEnd: number;
  status: string;
  retryCount: number;
  lastAttempt: Date;
}

export interface HealthCheckResult {
  unresolvedGaps: number;
  oldestGapAgeSeconds: number;
  lastProcessedSequence: number;
  healthy: boolean;
}

export class EventCatchupWorker {
  private pool: Pool;
  private bridge: SorobanBridge;
  private processor: EventProcessor;
  private running = false;

  constructor(pool: Pool, bridge: SorobanBridge, processor: EventProcessor) {
    this.pool = pool;
    this.bridge = bridge;
    this.processor = processor;
  }

  async ensureTables(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        sequence BIGINT NOT NULL,
        event_index INT NOT NULL,
        transaction_hash TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}',
        closed_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (sequence, event_index)
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ledger_gaps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        range_start BIGINT NOT NULL,
        range_end BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'discovered'
          CHECK (status IN ('discovered', 'filling', 'filled', 'escalated')),
        retry_count INT NOT NULL DEFAULT 0,
        last_attempt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ledger_gap_alerts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        gap_id UUID NOT NULL REFERENCES ledger_gaps(id),
        reason TEXT NOT NULL,
        acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async start(): Promise<void> {
    this.running = true;
    await this.ensureTables();

    while (this.running) {
      try {
        await this.runCycle();
      } catch (err) {
        console.error('Catchup cycle error:', err);
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  stop(): void {
    this.running = false;
  }

  private async runCycle(): Promise<void> {
    const gaps = await this.identifyGaps();
    for (const gap of gaps) {
      await this.fillGap(gap);
    }
  }

  async identifyGaps(): Promise<LedgerGap[]> {
    const result = await this.pool.query(`
      WITH seqs AS (
        SELECT sequence FROM ledger_events
        UNION
        SELECT range_start AS sequence FROM ledger_gaps WHERE status = 'filled'
        UNION
        SELECT range_end AS sequence FROM ledger_gaps WHERE status = 'filled'
      ),
      ordered AS (
        SELECT sequence,
               LAG(sequence) OVER (ORDER BY sequence) AS prev_seq
        FROM seqs
      )
      SELECT prev_seq + 1 AS range_start,
             sequence - 1 AS range_end
      FROM ordered
      WHERE prev_seq IS NOT NULL
        AND sequence - prev_seq > 1
    `);

    const discovered: LedgerGap[] = [];

    for (const row of result.rows) {
      const rangeStart = row.range_start as number;
      const rangeEnd = row.range_end as number;

      const existing = await this.pool.query(
        'SELECT 1 FROM ledger_gaps WHERE range_start = $1 AND range_end = $2 AND status IN ($3, $4)',
        [rangeStart, rangeEnd, 'discovered', 'filling'],
      );

      if (existing.rowCount === 0) {
        await this.pool.query(
          `INSERT INTO ledger_gaps (id, range_start, range_end, status, retry_count, last_attempt)
           VALUES ($1, $2, $3, 'discovered', 0, NOW())`,
          [uuidv4(), rangeStart, rangeEnd],
        );
      }

      discovered.push({
        rangeStart,
        rangeEnd,
        status: 'discovered',
        retryCount: 0,
        lastAttempt: new Date(),
      });
    }

    return discovered;
  }

  async fillGap(gap: LedgerGap): Promise<void> {
    const gapId = await this.getGapId(gap.rangeStart, gap.rangeEnd);
    if (!gapId) return;

    await this.pool.query(
      "UPDATE ledger_gaps SET status = 'filling', last_attempt = NOW() WHERE id = $1",
      [gapId],
    );

    try {
      const knownHash = await this.getKnownHash(gap.rangeEnd + 1);

      for (let seq = gap.rangeStart; seq <= gap.rangeEnd; seq++) {
        const ledger = await this.bridge.getLedger(seq);
        if (!ledger) {
          console.warn(`Ledger ${seq} not found on Horizon, skipping`);
          continue;
        }

        if (knownHash && ledger.transaction_set_hash !== knownHash) {
          throw new Error(
            `Hash mismatch at sequence ${seq}: expected ${knownHash}, got ${ledger.transaction_set_hash}`,
          );
        }

        const effects = await this.bridge.getLedgerEffects(seq);
        const events = effects.map((effect, idx) => ({
          sequence: seq,
          eventIndex: idx,
          transactionHash: ledger.transaction_set_hash,
          eventType: effect.type,
          payload: JSON.stringify(effect),
          closedAt: new Date(ledger.closed_at),
        }));

        await this.processor.insertEvents(events);
      }

      await this.pool.query("UPDATE ledger_gaps SET status = 'filled' WHERE id = $1", [gapId]);
    } catch (err) {
      await this.pool.query(
        `UPDATE ledger_gaps
         SET retry_count = retry_count + 1, last_attempt = NOW(),
             status = CASE WHEN retry_count >= 9 THEN 'escalated' ELSE 'discovered' END
         WHERE id = $1`,
        [gapId],
      );

      if (err instanceof Error) {
        await this.pool.query(
          `INSERT INTO ledger_gap_alerts (id, gap_id, reason)
           VALUES ($1, $2, $3)`,
          [uuidv4(), gapId, err.message],
        );
      }
    }
  }

  async getHealth(): Promise<HealthCheckResult> {
    const unresolved = await this.pool.query(
      "SELECT COUNT(*) AS count, MIN(last_attempt) AS oldest FROM ledger_gaps WHERE status IN ('discovered', 'filling')",
    );

    const lastSeq = await this.processor.getMaxSequence();
    const count = Number(unresolved.rows[0]?.count ?? 0);
    const oldest = unresolved.rows[0]?.oldest;

    return {
      unresolvedGaps: count,
      oldestGapAgeSeconds: oldest
        ? Math.floor((Date.now() - new Date(oldest).getTime()) / 1000)
        : 0,
      lastProcessedSequence: lastSeq,
      healthy: count === 0,
    };
  }

  private async getGapId(rangeStart: number, rangeEnd: number): Promise<string | null> {
    const result = await this.pool.query(
      'SELECT id FROM ledger_gaps WHERE range_start = $1 AND range_end = $2',
      [rangeStart, rangeEnd],
    );
    return result.rows[0]?.id ?? null;
  }

  private async getKnownHash(sequence: number): Promise<string | null> {
    const result = await this.pool.query(
      'SELECT transaction_hash FROM ledger_events WHERE sequence = $1 LIMIT 1',
      [sequence],
    );
    return result.rows[0]?.transaction_hash ?? null;
  }
}
