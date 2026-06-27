import { createHash } from 'crypto';
import type { Pool } from 'pg';

export interface VerificationResult {
  batchId: string;
  valid: boolean;
  computedHash: string;
  storedHash: string | null;
  sourceCount: number;
}

/**
 * Compute SHA256(concat of all source_hash values ordered by insertion id)
 * and compare against batches.integrity_hash.
 *
 * This is intentionally read-only: it does not acquire locks because
 * it is called after all sources have finished ingestion.
 */
export async function verifyBatchHash(
  pool: Pool,
  batchId: string,
): Promise<VerificationResult> {
  const [logResult, batchResult] = await Promise.all([
    pool.query<{ source_hash: string }>(
      `SELECT source_hash FROM batch_hash_log
       WHERE batch_id = $1
       ORDER BY id ASC`,
      [batchId],
    ),
    pool.query<{ integrity_hash: string | null }>(
      `SELECT integrity_hash FROM batches WHERE id = $1`,
      [batchId],
    ),
  ]);

  const hashes = logResult.rows.map((r) => r.source_hash);
  const computedHash = createHash('sha256')
    .update(hashes.join(''))
    .digest('hex');

  const storedHash = batchResult.rows[0]?.integrity_hash ?? null;

  return {
    batchId,
    valid: storedHash !== null && storedHash === computedHash,
    computedHash,
    storedHash,
    sourceCount: hashes.length,
  };
}

/**
 * Persist the computed aggregate hash back to batches.integrity_hash.
 * Called once, after all expected sources have submitted.
 */
export async function finaliseIntegrityHash(
  pool: Pool,
  batchId: string,
): Promise<string> {
  const { computedHash } = await verifyBatchHash(pool, batchId);

  await pool.query(
    `UPDATE batches SET integrity_hash = $1 WHERE id = $2`,
    [computedHash, batchId],
  );

  return computedHash;
}
