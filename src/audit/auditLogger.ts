import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

export class AuditLogger {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Records a batch state transition with a monotonically increasing sequence number.
   * Uses PostgreSQL advisory locks to serialize transitions for the same batch,
   * ensuring dense and unique sequence numbers even under high concurrency.
   *
   * @param batchId The UUID of the batch.
   * @param transition The transition description.
   */
  async logTransition(batchId: string, transition: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Step 1: Acquire advisory lock for this batch
      // Serializes concurrent logTransition calls for the same batchId
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [batchId]);

      // Step 2: Compute next sequence number within the lock
      const res = await client.query(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM batch_audit WHERE batch_id = $1',
        [batchId],
      );
      const nextSequence = res.rows[0].next_seq;

      // Step 3: Insert audit record
      const id = uuidv4();
      await client.query(
        'INSERT INTO batch_audit (id, batch_id, sequence, transition) VALUES ($1, $2, $3, $4)',
        [id, batchId, nextSequence, transition],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Failed to log transition:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Fetches all audit logs for a specific batch, ordered by sequence.
   * @param batchId The UUID of the batch.
   */
  async getAuditLogs(batchId: string) {
    const res = await this.pool.query(
      'SELECT sequence, transition, created_at FROM batch_audit WHERE batch_id = $1 ORDER BY sequence',
      [batchId],
    );
    return res.rows;
  }
}
