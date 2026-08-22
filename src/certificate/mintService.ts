import { Pool } from 'pg';
import * as crypto from 'crypto';

export interface MintResult {
  success: boolean;
  certificateId?: string;
  error?: string;
}

export class MintService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Mints a certificate for a batch.
   * Uses pg_advisory_lock and unique constraints to prevent double minting.
   */
  async mintCertificate(batchId: string, metadata: any): Promise<MintResult> {
    const lockKey = this.hashString(`cert_mint:${batchId}`);
    const client = await this.pool.connect();

    try {
      // 1. Acquire distributed lock
      await client.query('SELECT pg_advisory_lock($1)', [lockKey]);

      // 2. Check if already minted or in progress
      const checkResult = await client.query(
        'SELECT certificate_id, status FROM certificates WHERE batch_id = $1',
        [batchId],
      );

      if (checkResult.rows.length > 0) {
        const row = checkResult.rows[0];
        if (row.status === 'minted') {
          return { success: true, certificateId: row.certificate_id };
        }
        if (row.status === 'minting') {
          return { success: false, error: 'Minting already in progress' };
        }
      }

      // 3. Register minting intent (atomic check-and-insert)
      const insertResult = await client.query(
        "INSERT INTO certificates (batch_id, status) VALUES ($1, 'minting') ON CONFLICT (batch_id) DO NOTHING RETURNING id",
        [batchId],
      );

      if (insertResult.rows.length === 0) {
        // Re-check status if insert failed (race condition between select and insert)
        const recheck = await client.query(
          'SELECT certificate_id, status FROM certificates WHERE batch_id = $1',
          [batchId],
        );
        const row = recheck.rows[0];
        if (row.status === 'minted') {
          return { success: true, certificateId: row.certificate_id };
        }
        return { success: false, error: 'Minting already in progress' };
      }

      // 4. Perform the actual minting (Mock Soroban call)
      // In a real scenario, we'd use an idempotency key as per blueprint
      const idempotencyKey = this.generateIdempotencyKey(batchId);
      const certificateId = await this.mockSorobanMint(batchId, metadata, idempotencyKey);

      // 5. Update certificate record
      await client.query(
        "UPDATE certificates SET certificate_id = $1, status = 'minted' WHERE batch_id = $2",
        [certificateId, batchId],
      );

      return { success: true, certificateId };
    } catch (err) {
      console.error('Minting failed:', err);
      // Clean up failed intent if necessary
      await client.query("DELETE FROM certificates WHERE batch_id = $1 AND status = 'minting'", [
        batchId,
      ]);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // 6. Release lock and connection
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      client.release();
    }
  }

  private hashString(str: string): bigint {
    let hash = BigInt(0);
    for (let i = 0; i < str.length; i++) {
      hash = (hash << BigInt(5)) - hash + BigInt(str.charCodeAt(i));
      hash = hash & BigInt('0xFFFFFFFFFFFFFFFF');
    }
    return hash;
  }

  private generateIdempotencyKey(batchId: string): string {
    // SHA256(batch_id || 'cert_mint') as per blueprint
    const hash = crypto.createHash('sha256');
    hash.update(`${batchId}cert_mint`);
    return hash.digest('hex');
  }

  private async mockSorobanMint(
    batchId: string,
    metadata: any,
    idempotencyKey: string,
  ): Promise<string> {
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 100));
    return `cert_${batchId}_${Date.now()}`;
  }
}
