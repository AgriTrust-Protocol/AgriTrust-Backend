import { Pool } from 'pg';
import { BatchStatus } from './types/batchStatus';

/**
 * Audit logger for batch status transitions.
 *
 * Inserts immutable audit events with an idempotency key guard.
 * Duplicate transitions (same batch_id, transition_type, idempotency_key)
 * are silently ignored via ON CONFLICT DO NOTHING.
 *
 * Guarantee: ∀ batch: count(batch_audit_events[transition]) <= 1 per idempotency_key
 */
export class AuditLogger {
  constructor(private readonly pool: Pool) {}

  /**
   * Records a batch state transition in the audit log.
   *
   * The UNIQUE(batch_id, transition_type, idempotency_key) constraint
   * ensures that even under concurrent race conditions, only one audit
   * event per transition attempt is persisted. Duplicate inserts are
   * silently ignored (no error thrown).
   *
   * @returns true if the event was inserted, false if it was a duplicate.
   */
  async logTransition(
    batchId: string,
    transitionType: string,
    statusBefore: BatchStatus,
    statusAfter: BatchStatus,
    idempotencyKey: string,
  ): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO batch_audit_events
         (batch_id, transition_type, status_before, status_after, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (batch_id, transition_type, idempotency_key) DO NOTHING
       RETURNING id`,
      [batchId, transitionType, statusBefore, statusAfter, idempotencyKey],
    );

    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Fetches all audit events for a specific batch, ordered chronologically.
   */
  async getAuditEvents(batchId: string) {
    const res = await this.pool.query(
      `SELECT id, batch_id, transition_type, status_before, status_after,
              idempotency_key, created_at
         FROM batch_audit_events
        WHERE batch_id = $1
        ORDER BY created_at ASC`,
      [batchId],
    );
    return res.rows;
  }
}
