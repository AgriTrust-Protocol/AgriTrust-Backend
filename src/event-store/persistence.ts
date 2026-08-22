import { Pool, PoolClient } from 'pg';
import {
  ConcurrencyConflictError,
  EventMetadata,
  MAX_EVENT_PAYLOAD_BYTES,
  NewEvent,
  PayloadTooLargeError,
  StreamEvent,
} from './types';
import { timed } from '../api/metrics/event_store_metrics';

/** A persisted snapshot row (compressed bytes + the version it covers). */
export interface SnapshotRow {
  streamId: string;
  version: number;
  snapshot: Buffer;
  createdAt: string;
}

/** A batch of events bound for cold storage, grouped by archival prefix. */
export interface ArchivableEvent extends StreamEvent {
  createdAtDate: Date;
}

/**
 * Storage operations the event store depends on. Abstracted as an interface so
 * the higher-level `EventStream`/`Snapshotter` can be unit-tested against an
 * in-memory fake without a live PostgreSQL instance.
 */
export interface EventPersistence {
  getCurrentVersion(streamId: string): Promise<number>;
  appendEvents(
    streamId: string,
    events: NewEvent[],
    expectedVersion: number,
  ): Promise<StreamEvent[]>;
  readStreamEvents(streamId: string, afterVersion: number, limit: number): Promise<StreamEvent[]>;
  saveSnapshot(streamId: string, version: number, snapshot: Buffer): Promise<void>;
  getLatestSnapshot(streamId: string): Promise<SnapshotRow | null>;
}

/** Persistence operations required by the cold-storage archiver. */
export interface ArchivePersistence {
  readEventsOlderThan(cutoff: Date, limit: number): Promise<ArchivableEvent[]>;
  markArchived(globalSeqs: string[], coldStorageKey: string): Promise<void>;
}

/** Serialised byte size of an event's `data` payload (UTF-8). */
export function payloadSize(data: unknown): number {
  return Buffer.byteLength(JSON.stringify(data ?? null), 'utf8');
}

/**
 * PostgreSQL-backed event store persistence.
 *
 * Appends are atomic and optimistically concurrent: within a transaction we
 * confirm the current version matches `expectedVersion`, then insert the batch
 * with monotonically increasing per-stream versions. The
 * `UNIQUE (stream_id, stream_version)` constraint is the backstop against a
 * concurrent writer that passed the same check — a unique violation is
 * translated into a `ConcurrencyConflictError` (HTTP 409).
 */
export class PgEventPersistence implements EventPersistence {
  constructor(private readonly pool: Pool) {}

  async getCurrentVersion(streamId: string): Promise<number> {
    const res = await this.pool.query(
      `SELECT COALESCE(MAX(stream_version), 0)::int AS version
         FROM events WHERE stream_id = $1`,
      [streamId],
    );
    return Number(res.rows[0]?.version ?? 0);
  }

  async appendEvents(
    streamId: string,
    events: NewEvent[],
    expectedVersion: number,
  ): Promise<StreamEvent[]> {
    if (events.length === 0) return [];

    // Reject oversized payloads before touching the database.
    for (const e of events) {
      const size = payloadSize(e.data);
      if (size > MAX_EVENT_PAYLOAD_BYTES) {
        throw new PayloadTooLargeError(e.eventType, size);
      }
    }

    return timed('append', async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const current = await this.currentVersionTx(client, streamId);
        if (current !== expectedVersion) {
          await client.query('ROLLBACK');
          throw new ConcurrencyConflictError(streamId, expectedVersion, current);
        }

        const appended = await this.insertBatch(client, streamId, events, expectedVersion);

        await client.query('COMMIT');
        return appended;
      } catch (err) {
        await this.safeRollback(client);
        // 23505 = unique_violation → a concurrent writer won the race.
        if (this.isUniqueViolation(err)) {
          const actual = await this.getCurrentVersion(streamId);
          throw new ConcurrencyConflictError(streamId, expectedVersion, actual);
        }
        throw err;
      } finally {
        client.release();
      }
    });
  }

  async readStreamEvents(
    streamId: string,
    afterVersion: number,
    limit: number,
  ): Promise<StreamEvent[]> {
    return timed('read', async () => {
      const res = await this.pool.query(
        `SELECT global_seq, stream_id, stream_version, event_type, data, metadata, created_at
           FROM events
          WHERE stream_id = $1 AND stream_version > $2 AND archived_at IS NULL
          ORDER BY stream_version ASC
          LIMIT $3`,
        [streamId, afterVersion, limit],
      );
      return res.rows.map(mapRow);
    });
  }

  async saveSnapshot(streamId: string, version: number, snapshot: Buffer): Promise<void> {
    await this.pool.query(
      `INSERT INTO snapshots (stream_id, version, snapshot)
       VALUES ($1, $2, $3)
       ON CONFLICT (stream_id, version) DO UPDATE SET snapshot = EXCLUDED.snapshot`,
      [streamId, version, snapshot],
    );
  }

  async getLatestSnapshot(streamId: string): Promise<SnapshotRow | null> {
    const res = await this.pool.query(
      `SELECT stream_id, version, snapshot, created_at
         FROM snapshots
        WHERE stream_id = $1
        ORDER BY version DESC
        LIMIT 1`,
      [streamId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      streamId: row.stream_id,
      version: Number(row.version),
      snapshot: row.snapshot,
      createdAt: row.created_at,
    };
  }

  // ── archival helpers (used by ColdStorageArchiver) ──────────────────────

  /** Reads a page of events older than `cutoff` that have not been archived. */
  async readEventsOlderThan(cutoff: Date, limit: number): Promise<ArchivableEvent[]> {
    const res = await this.pool.query(
      `SELECT global_seq, stream_id, stream_version, event_type, data, metadata, created_at
         FROM events
        WHERE created_at < $1 AND archived_at IS NULL
        ORDER BY created_at ASC
        LIMIT $2`,
      [cutoff, limit],
    );
    return res.rows.map((r) => ({
      ...mapRow(r),
      createdAtDate: new Date(r.created_at),
    }));
  }

  /**
   * Marks events as archived: retains a pointer to cold storage and nulls out
   * the bulky JSONB payload to reclaim hot-storage space.
   */
  async markArchived(globalSeqs: string[], coldStorageKey: string): Promise<void> {
    if (globalSeqs.length === 0) return;
    await this.pool.query(
      `UPDATE events
          SET cold_storage_key = $1,
              archived_at = NOW(),
              data = '{}'::jsonb
        WHERE global_seq = ANY($2::bigint[])`,
      [coldStorageKey, globalSeqs],
    );
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async currentVersionTx(client: PoolClient, streamId: string): Promise<number> {
    const res = await client.query(
      `SELECT COALESCE(MAX(stream_version), 0)::int AS version
         FROM events WHERE stream_id = $1`,
      [streamId],
    );
    return Number(res.rows[0]?.version ?? 0);
  }

  private async insertBatch(
    client: PoolClient,
    streamId: string,
    events: NewEvent[],
    expectedVersion: number,
  ): Promise<StreamEvent[]> {
    // Build a single multi-row INSERT. Versions are assigned contiguously
    // starting at expectedVersion + 1.
    const tuples: string[] = [];
    const values: unknown[] = [];
    events.forEach((e, i) => {
      const base = i * 5;
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}::jsonb)`,
      );
      values.push(
        streamId,
        expectedVersion + i + 1,
        e.eventType,
        JSON.stringify(e.data ?? {}),
        JSON.stringify((e.metadata as EventMetadata) ?? {}),
      );
    });

    const res = await client.query(
      `INSERT INTO events (stream_id, stream_version, event_type, data, metadata)
       VALUES ${tuples.join(', ')}
       RETURNING global_seq, stream_id, stream_version, event_type, data, metadata, created_at`,
      values,
    );
    return res.rows.map(mapRow);
  }

  private async safeRollback(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be aborted; ignore */
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
  }
}

function mapRow(row: any): StreamEvent {
  return {
    globalSeq: String(row.global_seq),
    streamId: row.stream_id,
    streamVersion: Number(row.stream_version),
    eventType: row.event_type,
    data: row.data ?? {},
    metadata: row.metadata ?? {},
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
