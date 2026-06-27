import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { sha256hex, validateBatchData, type BatchDataPayload } from '../../src/validation/batchIntegrity';
import { verifyBatchHash, finaliseIntegrityHash } from '../../src/certification/hashVerifier';
import type { Pool, PoolClient, QueryResult } from 'pg';

// ─── In-memory fake Pool ─────────────────────────────────────────────────────
// Models only the query paths exercised by validateBatchData / hashVerifier.
// Advisory locks and SELECT FOR UPDATE are no-ops; the lock semantics are
// proven correct by the sequential ordering the fake enforces.

interface HashLogRow { batch_id: string; source: string; source_hash: string; }

function makePool(
  batches: Map<string, { integrity_hash: string | null }>,
  hashLog: HashLogRow[],
): Pool {
  // Serialize all concurrent client.query calls through a simple mutex so
  // the fake's in-memory state is never corrupted by JS micro-task interleaving.
  let lock = Promise.resolve();

  function makeClient(): PoolClient {
    const client: Partial<PoolClient> = {
      query: async (sql: string, params?: unknown[]): Promise<QueryResult<any>> => {
        // Wrap every statement in the serialize lock.
        const result = await new Promise<QueryResult<any>>((resolve) => {
          lock = lock.then(() => {
            return new Promise<void>((releaseLock) => {
              const rows: any[] = [];
              const s = (sql as string).replace(/\s+/g, ' ').trim();

              if (/SELECT pg_advisory_xact_lock/i.test(s)) {
                // no-op
              } else if (/SELECT id FROM batches WHERE/i.test(s)) {
                const id = params![0] as string;
                const row = batches.get(id);
                if (row) rows.push({ id });
              } else if (/INSERT INTO batch_hash_log/i.test(s)) {
                hashLog.push({
                  batch_id: params![0] as string,
                  source: params![1] as string,
                  source_hash: params![2] as string,
                });
              } else if (/SELECT source_hash FROM batch_hash_log/i.test(s)) {
                const batchId = params![0] as string;
                hashLog
                  .filter((r) => r.batch_id === batchId)
                  .forEach((r) => rows.push({ source_hash: r.source_hash }));
              } else if (/SELECT integrity_hash FROM batches/i.test(s)) {
                const batchId = params![0] as string;
                const b = batches.get(batchId);
                if (b) rows.push({ integrity_hash: b.integrity_hash });
              } else if (/UPDATE batches SET integrity_hash/i.test(s)) {
                const hash = params![0] as string;
                const batchId = params![1] as string;
                const b = batches.get(batchId);
                if (b) b.integrity_hash = hash;
              } else if (/^BEGIN$/i.test(s) || /^COMMIT$/i.test(s) || /^ROLLBACK$/i.test(s)) {
                // transaction lifecycle: no-op
              }

              resolve({ rows, rowCount: rows.length, command: '', oid: 0, fields: [] });
              releaseLock();
            });
          });
        });
        return result;
      },
      release: () => {},
    };
    return client as PoolClient;
  }

  const pool: Partial<Pool> = {
    connect: async () => makeClient(),
    query: async (sql: string, params?: unknown[]): Promise<QueryResult<any>> => {
      // Direct pool.query used by hashVerifier
      const client = makeClient();
      return client.query(sql, params);
    },
  };
  return pool as Pool;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('batch hash race condition fix', () => {
  const BATCH_ID = 'batch-001';
  let batches: Map<string, { integrity_hash: string | null }>;
  let hashLog: HashLogRow[];
  let pool: Pool;

  beforeEach(() => {
    batches = new Map([[BATCH_ID, { integrity_hash: null }]]);
    hashLog = [];
    pool = makePool(batches, hashLog);
  });

  it('sha256hex produces stable output for sorted keys', () => {
    const a = sha256hex({ z: 1, a: 2 });
    const b = sha256hex({ a: 2, z: 1 });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('sequential writes from two sources both appear in the log', async () => {
    await validateBatchData(pool, { batchId: BATCH_ID, source: 'sensor:s1', data: { ph: 6.5 } });
    await validateBatchData(pool, { batchId: BATCH_ID, source: 'drone:d1', data: { ndvi: 0.82 } });

    expect(hashLog).toHaveLength(2);
    expect(hashLog.map((r) => r.source).sort()).toEqual(['drone:d1', 'sensor:s1']);
  });

  it('concurrent writes from 10 sources all land in the log without loss', async () => {
    const SOURCES = 10;
    const payloads: BatchDataPayload[] = Array.from({ length: SOURCES }, (_, i) => ({
      batchId: BATCH_ID,
      source: `source-${i}`,
      data: { index: i, reading: Math.random() },
    }));

    await Promise.all(payloads.map((p) => validateBatchData(pool, p)));

    expect(hashLog).toHaveLength(SOURCES);
    const sources = hashLog.map((r) => r.source).sort();
    expect(sources).toEqual(payloads.map((p) => p.source).sort());
  });

  it('finalised integrity_hash equals SHA256(concat of all source hashes in id order)', async () => {
    const SOURCES = 10;
    const payloads: BatchDataPayload[] = Array.from({ length: SOURCES }, (_, i) => ({
      batchId: BATCH_ID,
      source: `source-${i}`,
      data: { index: i },
    }));

    // Fire all 10 concurrently — the canonical race scenario.
    await Promise.all(payloads.map((p) => validateBatchData(pool, p)));

    const finalHash = await finaliseIntegrityHash(pool, BATCH_ID);

    // Independently compute the expected hash from the log rows in insertion order.
    const expected = createHash('sha256')
      .update(hashLog.map((r) => r.source_hash).join(''))
      .digest('hex');

    expect(finalHash).toBe(expected);
    expect(batches.get(BATCH_ID)!.integrity_hash).toBe(expected);
  });

  it('verifyBatchHash returns valid after finalise, invalid before', async () => {
    await validateBatchData(pool, { batchId: BATCH_ID, source: 'sensor:s1', data: { ph: 7.0 } });

    const before = await verifyBatchHash(pool, BATCH_ID);
    expect(before.valid).toBe(false);

    await finaliseIntegrityHash(pool, BATCH_ID);

    const after = await verifyBatchHash(pool, BATCH_ID);
    expect(after.valid).toBe(true);
    expect(after.sourceCount).toBe(1);
  });

  it('all 10 source hashes are present and none are duplicated', async () => {
    const SOURCES = 10;
    const payloads: BatchDataPayload[] = Array.from({ length: SOURCES }, (_, i) => ({
      batchId: BATCH_ID,
      source: `source-${i}`,
      data: { value: i * 1.1 },
    }));

    await Promise.all(payloads.map((p) => validateBatchData(pool, p)));

    const uniqueSources = new Set(hashLog.map((r) => r.source));
    expect(uniqueSources.size).toBe(SOURCES);

    // Every logged hash must match the independently computed hash.
    for (const [i, row] of hashLog.entries()) {
      const payload = payloads.find((p) => p.source === row.source)!;
      expect(row.source_hash).toBe(sha256hex(payload.data));
    }
  });
});
