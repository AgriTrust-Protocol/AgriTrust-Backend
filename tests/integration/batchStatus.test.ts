import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { DataType, newDb } from 'pg-mem';
import { BatchStatusWorkflow } from '../../src/workflows/batchStatus';
import { BatchStatus, TransitionResult } from '../../src/workflows/types/batchStatus';

/**
 * Concurrent transition integration test.
 *
 * Simulates multiple concurrent callers attempting to transition the same
 * batch. Verifies that each transition fires exactly once — no duplicate
 * audit events, no skipped states, no double-processing.
 */

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS batches (
      id          UUID PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'REGISTERED',
      version     INT NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS batch_audit_events (
      id              BIGSERIAL PRIMARY KEY,
      batch_id        UUID NOT NULL REFERENCES batches(id),
      transition_type TEXT NOT NULL,
      status_before   TEXT NOT NULL,
      status_after    TEXT NOT NULL,
      idempotency_key UUID NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(batch_id, transition_type, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS processed_transitions (
      id              BIGSERIAL PRIMARY KEY,
      batch_id        UUID NOT NULL REFERENCES batches(id),
      transition_id   UUID NOT NULL,
      status_before   TEXT NOT NULL,
      status_after    TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(batch_id, status_before, status_after)
  );

  -- validate_transition is registered as a JS function (pg-mem compat).
`;

function createTestDb() {
  const db = newDb({ autoCreateForeignKeyIndices: true });

  let uuidSeq = 0;
  const randomHex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid' as any,
    implementation: () => {
      uuidSeq += 1;
      const hi = BigInt(Date.now()) * BigInt(1000) + BigInt(uuidSeq);
      const hiHex = hi.toString(16).padStart(16, '0').slice(-16);
      return `${hiHex.slice(0,8)}-${hiHex.slice(8,12)}-7${hiHex.slice(13,16)}-${randomHex()}-${randomHex()}${randomHex()}`;
    },
  });

  // Register validate_transition as a JS function since pg-mem does not
  // support plpgsql. Mirrors the SQL implementation in the migration.
  db.public.registerFunction({
    name: 'validate_transition',
    args: [DataType.text, DataType.text],
    returns: DataType.bool,
    implementation: (current: string, next: string) => {
      const validNext: Record<string, string[]> = {
        REGISTERED: ['INSPECTED'],
        INSPECTED: ['CERTIFIED'],
        CERTIFIED: ['SHIPPED'],
        SHIPPED: ['DELIVERED'],
        DELIVERED: [],
      };
      return (validNext[current] ?? []).includes(next);
    },
  });

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return { db, pool };
}

async function getBatchStatus(pool: any, id: string): Promise<BatchStatus | null> {
  const res = await pool.query(`SELECT status FROM batches WHERE id = '${id}'`);
  return (res.rows[0]?.status as BatchStatus) ?? null;
}

async function getBatchVersion(pool: any, id: string): Promise<number> {
  const res = await pool.query(`SELECT version FROM batches WHERE id = '${id}'`);
  return Number(res.rows[0]?.version ?? 0);
}

async function countAuditForTransition(
  pool: any,
  batchId: string,
  statusBefore: string,
  statusAfter: string,
): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM batch_audit_events
      WHERE batch_id = '${batchId}' AND status_before = '${statusBefore}' AND status_after = '${statusAfter}'`,
  );
  return res.rows[0]?.cnt ?? 0;
}

async function countProcessedTransitions(pool: any, batchId: string): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM processed_transitions WHERE batch_id = '${batchId}'`,
  );
  return res.rows[0]?.cnt ?? 0;
}

describe('BatchStatusWorkflow — concurrent transitions', () => {
  let pool: any;
  let workflow: BatchStatusWorkflow;

  beforeEach(async () => {
    const { pool: p } = createTestDb();
    pool = p;
    await pool.query(SCHEMA_SQL);
    workflow = new BatchStatusWorkflow(pool);
  });

  afterEach(async () => {
    if (workflow) {
      workflow.engine.shutdown();
    }
    try { await pool?.end(); } catch {}
  });

  it('concurrent INSPECTED→CERTIFIED: exactly one transition succeeds, no duplicates', async () => {
    const batchId = uuidv7();
    await pool.query(
      `INSERT INTO batches (id, status, version) VALUES ('${batchId}', 'INSPECTED', 1)`,
    );

    // Fire 10 concurrent transition attempts for the same batch.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        workflow.transitionBatch({ batchId, targetStatus: 'CERTIFIED' }),
      ),
    );

    // Count results by code.
    const byCode = new Map<number, TransitionResult[]>();
    for (const r of results) {
      const existing = byCode.get(r.code) ?? [];
      existing.push(r);
      byCode.set(r.code, existing);
    }

    // At least one should be 200 (first writer wins).
    const okResults = byCode.get(200) ?? [];
    expect(okResults.length).toBeGreaterThanOrEqual(1);

    // Final state must be CERTIFIED.
    expect(await getBatchStatus(pool, batchId)).toBe('CERTIFIED');

    // Version should be exactly 2 (one transition from version 1).
    expect(await getBatchVersion(pool, batchId)).toBe(2);

    // Exactly ONE audit event for INSPECTED→CERTIFIED.
    const auditCount = await countAuditForTransition(
      pool,
      batchId,
      'INSPECTED',
      'CERTIFIED',
    );
    expect(auditCount).toBe(1);

    // Exactly ONE processed_transitions entry.
    expect(await countProcessedTransitions(pool, batchId)).toBe(1);
  });

  it('concurrent transitions across 100 batches: all end in correct states', async () => {
    const batchIds = Array.from({ length: 100 }, () => uuidv7());

    // Seed all batches in INSPECTED state.
    for (const id of batchIds) {
      await pool.query(
        `INSERT INTO batches (id, status, version) VALUES ('${id}', 'INSPECTED', 1)`,
      );
    }

    // Concurrently transition each batch to CERTIFIED.
    const results = await Promise.all(
      batchIds.map((id) =>
        workflow.transitionBatch({ batchId: id, targetStatus: 'CERTIFIED' }),
      ),
    );

    // All must succeed (200).
    for (const r of results) {
      expect(r.code).toBe(200);
      expect(r.success).toBe(true);
    }

    // Verify all 100 batches reached CERTIFIED.
    for (const id of batchIds) {
      expect(await getBatchStatus(pool, id)).toBe('CERTIFIED');
      expect(await getBatchVersion(pool, id)).toBe(2);
      expect(await countAuditForTransition(pool, id, 'INSPECTED', 'CERTIFIED')).toBe(1);
      expect(await countProcessedTransitions(pool, id)).toBe(1);
    }
  }, 15000);

  it('full lifecycle under concurrent pressure: audit invariant holds', async () => {
    const batchId = uuidv7();
    await pool.query(
      `INSERT INTO batches (id, status, version) VALUES ('${batchId}', 'REGISTERED', 1)`,
    );

    const lifecycle: BatchStatus[] = ['INSPECTED', 'CERTIFIED', 'SHIPPED', 'DELIVERED'];

    // Apply each transition sequentially but with duplicate concurrent
    // attempts to stress-test idempotency at each step.
    for (const target of lifecycle) {
      const results = await Promise.all([
        workflow.transitionBatch({ batchId, targetStatus: target }),
        workflow.transitionBatch({ batchId, targetStatus: target }),
        workflow.transitionBatch({ batchId, targetStatus: target }),
      ]);

      // Exactly one gets 200, the rest get 202 or 409.
      const successResults = results.filter((r) => r.code === 200);
      expect(successResults.length).toBe(1);
    }

    // Final state.
    expect(await getBatchStatus(pool, batchId)).toBe('DELIVERED');
    expect(await getBatchVersion(pool, batchId)).toBe(5);

    // Audit invariant: exactly 4 audit events, one per transition.
    const expectedPairs: [string, string][] = [
      ['REGISTERED', 'INSPECTED'],
      ['INSPECTED', 'CERTIFIED'],
      ['CERTIFIED', 'SHIPPED'],
      ['SHIPPED', 'DELIVERED'],
    ];

    for (const [before, after] of expectedPairs) {
      const count = await countAuditForTransition(pool, batchId, before, after);
      expect(count).toBe(1);
    }

    // Processed transitions: exactly 4.
    expect(await countProcessedTransitions(pool, batchId)).toBe(4);
  });

  it('cross-batch concurrent transitions: no cross-talk between batches', async () => {
    const batchA = uuidv7();
    const batchB = uuidv7();

    await pool.query(
      `INSERT INTO batches (id, status, version) VALUES ('${batchA}', 'REGISTERED', 1)`,
    );
    await pool.query(
      `INSERT INTO batches (id, status, version) VALUES ('${batchB}', 'REGISTERED', 1)`,
    );

    await Promise.all([
      workflow.transitionBatch({ batchId: batchA, targetStatus: 'INSPECTED' }),
      workflow.transitionBatch({ batchId: batchB, targetStatus: 'INSPECTED' }),
    ]);

    expect(await getBatchStatus(pool, batchA)).toBe('INSPECTED');
    expect(await getBatchStatus(pool, batchB)).toBe('INSPECTED');

    expect(await countProcessedTransitions(pool, batchA)).toBe(1);
    expect(await countProcessedTransitions(pool, batchB)).toBe(1);
  });
});
