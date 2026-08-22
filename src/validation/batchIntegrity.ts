import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';

export type DataSource = 'sensor' | 'drone' | 'inspector' | string;

export interface BatchDataPayload {
  batchId: string;
  source: DataSource;
  /** Raw source data to be hashed and appended. */
  data: Record<string, unknown>;
}

/**
 * Compute SHA-256 of a JSON-deterministic serialisation.
 * Keys are sorted to ensure identical payloads produce identical hashes.
 */
export function sha256hex(obj: Record<string, unknown>): string {
  const stable = JSON.stringify(obj, Object.keys(obj).sort());
  return createHash('sha256').update(stable).digest('hex');
}

/**
 * Append a source's hash to batch_hash_log under two locks:
 *   1. pg_advisory_xact_lock(batch_source_lock_key(batch_id, source))
 *      — serialises writes from the same (batch, source) pair.
 *   2. SELECT … FOR UPDATE on the batch row
 *      — prevents concurrent readers from acting on a stale integrity_hash.
 *
 * The function is intentionally small: it only appends the new log row.
 * The aggregate hash is computed lazily at certification time by hashVerifier.
 */
export async function validateBatchData(
  pool: Pool,
  payload: BatchDataPayload,
): Promise<{ sourceHash: string }> {
  const { batchId, source, data } = payload;
  const sourceHash = sha256hex(data);

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // Advisory lock: serialise per (batch, source).
    await client.query(`SELECT pg_advisory_xact_lock(batch_source_lock_key($1, $2))`, [
      batchId,
      source,
    ]);

    // Row lock: guard against concurrent batch updates.
    await client.query(`SELECT id FROM batches WHERE id = $1 FOR UPDATE`, [batchId]);

    await client.query(
      `INSERT INTO batch_hash_log (batch_id, source, source_hash)
       VALUES ($1, $2, $3)`,
      [batchId, source, sourceHash],
    );

    await client.query('COMMIT');
    return { sourceHash };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
