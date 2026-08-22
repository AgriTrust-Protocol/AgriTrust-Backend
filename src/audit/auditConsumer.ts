import { Pool } from 'pg';

export class AuditConsumer {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Replays audit events for a batch in the correct sequence order.
   * Ensures that events are processed in the order they were assigned sequence numbers.
   *
   * @param batchId The UUID of the batch.
   * @returns Array of audit events.
   */
  async replayBatch(batchId: string): Promise<any[]> {
    const res = await this.pool.query(
      'SELECT * FROM batch_audit WHERE batch_id = $1 ORDER BY sequence ASC',
      [batchId],
    );
    return res.rows;
  }
}
