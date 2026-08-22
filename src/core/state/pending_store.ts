import { Pool } from 'pg';

export type PendingTxStatus = 'pending' | 'committed' | 'rolled_back';

export interface PendingTransactionRow {
  tx_uuid: string;
  cargo_id: string;
  operation_type: string;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  soroban_hash: string | null;
  status: PendingTxStatus;
  created_at: string;
  timeout_at: string;
}

/**
 * Persistence layer for the two-phase commit pending_transactions table.
 *
 * Each row represents a tentative state change that has been applied locally
 * but not yet confirmed on-chain.  The coordinator writes rows through this
 * store and the recovery worker reads timed-out rows to trigger rollbacks.
 */
export class PendingStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Inserts a new pending transaction.  Throws if another pending row for the
   * same cargo_id already exists (enforces sequential processing per cargo).
   */
  async insert(row: {
    txUuid: string;
    cargoId: string;
    operationType: string;
    beforeState: Record<string, unknown>;
    afterState: Record<string, unknown>;
    timeoutAt: Date;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: existing } = await client.query(
        `SELECT tx_uuid FROM pending_transactions
          WHERE cargo_id = $1 AND status = 'pending'
          FOR UPDATE`,
        [row.cargoId],
      );

      if (existing.length > 0) {
        await client.query('ROLLBACK');
        throw new Error(
          `Overlapping pending transaction for cargo_id=${row.cargoId} (existing tx_uuid=${existing[0].tx_uuid})`,
        );
      }

      await client.query(
        `INSERT INTO pending_transactions
           (tx_uuid, cargo_id, operation_type, before_state, after_state, status, timeout_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
        [
          row.txUuid,
          row.cargoId,
          row.operationType,
          JSON.stringify(row.beforeState),
          JSON.stringify(row.afterState),
          row.timeoutAt.toISOString(),
        ],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Transitions a pending row to 'committed' and records the Soroban hash. */
  async markCommitted(txUuid: string, sorobanHash: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE pending_transactions
          SET status = 'committed', soroban_hash = $2
        WHERE tx_uuid = $1 AND status = 'pending'`,
      [txUuid, sorobanHash],
    );
    if (rowCount === 0) {
      throw new Error(`Cannot commit tx_uuid=${txUuid}: not found or not in pending status`);
    }
  }

  /** Transitions a pending row to 'rolled_back'. */
  async markRolledBack(txUuid: string): Promise<void> {
    await this.pool.query(
      `UPDATE pending_transactions
          SET status = 'rolled_back'
        WHERE tx_uuid = $1 AND status = 'pending'`,
      [txUuid],
    );
  }

  /** Sets the soroban_hash on a pending row (before commit/rollback decision). */
  async setSorobanHash(txUuid: string, sorobanHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE pending_transactions
          SET soroban_hash = $2
        WHERE tx_uuid = $1`,
      [txUuid, sorobanHash],
    );
  }

  /** Returns a single pending transaction by UUID, or null. */
  async getByUuid(txUuid: string): Promise<PendingTransactionRow | null> {
    const { rows } = await this.pool.query(
      `SELECT tx_uuid, cargo_id, operation_type, before_state, after_state,
              soroban_hash, status, created_at, timeout_at
         FROM pending_transactions
        WHERE tx_uuid = $1`,
      [txUuid],
    );
    return (rows[0] as PendingTransactionRow) ?? null;
  }

  /**
   * Returns all rows that are still pending but whose timeout has elapsed.
   * Used by the recovery worker.
   */
  async findTimedOut(now: Date = new Date()): Promise<PendingTransactionRow[]> {
    const { rows } = await this.pool.query(
      `SELECT tx_uuid, cargo_id, operation_type, before_state, after_state,
              soroban_hash, status, created_at, timeout_at
         FROM pending_transactions
        WHERE status = 'pending' AND timeout_at < $1
        ORDER BY created_at ASC`,
      [now.toISOString()],
    );
    return rows as PendingTransactionRow[];
  }
}
