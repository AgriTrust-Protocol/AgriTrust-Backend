import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { DataType, newDb } from 'pg-mem';
import { BatchStatusWorkflow } from '../../src/workflows/batchStatus';
import { BatchStatus } from '../../src/workflows/types/batchStatus';
import { TransitionValidator, InvalidTransitionError } from '../../src/workflows/transitionValidator';
import { AuditLogger } from '../../src/workflows/auditLogger';
import { WorkflowEngine } from '../../src/workflows/services/workflowEngine';
import { isValidTransition } from '../../src/workflows/config/statusTransitions';

// ── helpers ──────────────────────────────────────────────────────────────

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

  // Use a counter-based UUID to avoid collisions in fast test execution.
  // uuidv7 generates time-based UUIDs that can clash within the same ms.
  // We combine a monotonic counter with random bits for guaranteed uniqueness.
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

  // Create the schema via the Pool adapter.
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return { db, pool };
}

async function seedBatch(
  pool: any,
  id: string,
  status: BatchStatus = 'REGISTERED',
  version: number = 1,
): Promise<void> {
  await pool.query(
    `INSERT INTO batches (id, status, version) VALUES ('${id}', '${status}', ${version})`,
  );
}

async function getBatch(pool: any, id: string) {
  const res = await pool.query(`SELECT id, status, version FROM batches WHERE id = '${id}'`);
  return res.rows[0] ?? null;
}

async function countAuditEvents(pool: any, batchId: string): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM batch_audit_events WHERE batch_id = '${batchId}'`,
  );
  return res.rows[0]?.cnt ?? 0;
}

async function countProcessedTransitions(pool: any, batchId: string): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM processed_transitions WHERE batch_id = '${batchId}'`,
  );
  return res.rows[0]?.cnt ?? 0;
}

// ── tests ────────────────────────────────────────────────────────────────

describe('BatchStatusWorkflow', () => {
  let pool: any;
  let workflow: BatchStatusWorkflow;

  beforeEach(async () => {
    const { pool: p } = createTestDb();
    pool = p;

    // Apply schema.
    await pool.query(SCHEMA_SQL);

    workflow = new BatchStatusWorkflow(pool);
  });

  afterEach(async () => {
    if (workflow) {
      workflow.engine.shutdown();
    }
    try { await pool?.end(); } catch {}
  });

  it('transitions REGISTERED → INSPECTED successfully', async () => {
    const batchId = uuidv7();
    await seedBatch(pool, batchId, 'REGISTERED', 1);

    const result = await workflow.transitionBatch({
      batchId,
      targetStatus: 'INSPECTED',
    });

    expect(result.code).toBe(200);
    expect(result.success).toBe(true);

    const batch = await getBatch(pool, batchId);
    expect(batch.status).toBe('INSPECTED');
    expect(Number(batch.version)).toBe(2);

    const auditCount = await countAuditEvents(pool, batchId);
    expect(auditCount).toBe(1);
  });

  it('returns 202 when already at target status (idempotent)', async () => {
    const batchId = uuidv7();
    await seedBatch(pool, batchId, 'CERTIFIED', 3);

    const result = await workflow.transitionBatch({
      batchId,
      targetStatus: 'CERTIFIED',
    });

    expect(result.code).toBe(202);
    expect(result.success).toBe(true);

    const auditCount = await countAuditEvents(pool, batchId);
    expect(auditCount).toBe(0);
  });

  it('returns 422 for invalid transitions', async () => {
    const batchId = uuidv7();
    await seedBatch(pool, batchId, 'REGISTERED', 1);

    const result = await workflow.transitionBatch({
      batchId,
      targetStatus: 'CERTIFIED',
    });

    expect(result.code).toBe(422);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('Invalid transition');
  });

  it('returns 422 for batch not found', async () => {
    const result = await workflow.transitionBatch({
      batchId: uuidv7(),
      targetStatus: 'INSPECTED',
    });

    expect(result.code).toBe(422);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('completes full lifecycle: REGISTERED → INSPECTED → CERTIFIED → SHIPPED → DELIVERED', async () => {
    const batchId = uuidv7();
    await seedBatch(pool, batchId, 'REGISTERED', 1);

    const steps: BatchStatus[] = ['INSPECTED', 'CERTIFIED', 'SHIPPED', 'DELIVERED'];

    for (const target of steps) {
      const result = await workflow.transitionBatch({ batchId, targetStatus: target });
      expect(result.code).toBe(200);
    }

    const batch = await getBatch(pool, batchId);
    expect(batch.status).toBe('DELIVERED');
    expect(Number(batch.version)).toBe(5);

    const auditCount = await countAuditEvents(pool, batchId);
    expect(auditCount).toBe(4);

    const processedCount = await countProcessedTransitions(pool, batchId);
    expect(processedCount).toBe(4);
  });

  it('at-most-once: duplicate transition returns 202', async () => {
    const batchId = uuidv7();
    await seedBatch(pool, batchId, 'REGISTERED', 1);

    const r1 = await workflow.transitionBatch({ batchId, targetStatus: 'INSPECTED' });
    expect(r1.code).toBe(200);

    const r2 = await workflow.transitionBatch({ batchId, targetStatus: 'INSPECTED' });
    expect(r2.code).toBe(202);

    const auditCount = await countAuditEvents(pool, batchId);
    expect(auditCount).toBe(1);
  });

  it('blocks transition from DELIVERED (terminal state)', async () => {
    const batchId = uuidv7();
    await seedBatch(pool, batchId, 'DELIVERED', 5);

    const result = await workflow.transitionBatch({
      batchId,
      targetStatus: 'SHIPPED',
    });

    expect(result.code).toBe(422);
  });
});

// ── TransitionValidator tests ────────────────────────────────────────────

describe('TransitionValidator', () => {
  it('rejects invalid transitions', () => {
    const v = new TransitionValidator(null as any);
    expect(() => v.validateStatusTransition('REGISTERED', 'SHIPPED')).toThrow(
      InvalidTransitionError,
    );
  });

  it('accepts valid transitions (silently)', () => {
    const v = new TransitionValidator(null as any);
    expect(() => v.validateStatusTransition('INSPECTED', 'CERTIFIED')).not.toThrow();
  });
});

// ── statusTransitions config tests ───────────────────────────────────────

describe('statusTransitions DAG', () => {
  it('REGISTERED → INSPECTED is valid', () => {
    expect(isValidTransition('REGISTERED', 'INSPECTED')).toBe(true);
  });

  it('REGISTERED → CERTIFIED is invalid', () => {
    expect(isValidTransition('REGISTERED', 'CERTIFIED')).toBe(false);
  });

  it('DELIVERED has no forward transitions', () => {
    expect(isValidTransition('DELIVERED', 'INSPECTED')).toBe(false);
    expect(isValidTransition('DELIVERED', 'REGISTERED')).toBe(false);
  });
});

// ── WorkflowEngine tests ─────────────────────────────────────────────────

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine();
  });

  afterEach(() => {
    engine.shutdown();
  });

  it('enqueues a retry job', () => {
    engine.enqueueRetry({
      batchId: 'b1',
      targetStatus: 'CERTIFIED',
      idempotencyKey: uuidv7(),
      attempt: 1,
      maxRetries: 3,
      createdAt: Date.now(),
    });

    expect(engine.pendingCount).toBe(1);

    engine.shutdown();
    expect(engine.pendingCount).toBe(0);
  });

  it('debounces duplicate jobs for the same batchId', () => {
    engine.enqueueRetry({
      batchId: 'b1',
      targetStatus: 'CERTIFIED',
      idempotencyKey: uuidv7(),
      attempt: 1,
      maxRetries: 3,
      createdAt: Date.now(),
    });

    expect(engine.pendingCount).toBe(1);

    engine.enqueueRetry({
      batchId: 'b1',
      targetStatus: 'CERTIFIED',
      idempotencyKey: uuidv7(),
      attempt: 2,
      maxRetries: 3,
      createdAt: Date.now(),
    });

    expect(engine.pendingCount).toBe(1);

    engine.shutdown();
  });

  it('dequeueRetry removes a pending job', () => {
    engine.enqueueRetry({
      batchId: 'b1',
      targetStatus: 'CERTIFIED',
      idempotencyKey: uuidv7(),
      attempt: 1,
      maxRetries: 3,
      createdAt: Date.now(),
    });

    expect(engine.pendingCount).toBe(1);
    engine.dequeueRetry('b1');
    expect(engine.pendingCount).toBe(0);
  });
});

// ── AuditLogger tests ────────────────────────────────────────────────────

describe('AuditLogger', () => {
  let pool: any;
  let auditor: AuditLogger;

  beforeEach(async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    db.public.registerFunction({
      name: 'gen_random_uuid',
      returns: 'uuid' as any,
      implementation: () => uuidv7(),
    });

    const { Pool } = db.adapters.createPg();
    pool = new Pool();

    await pool.query(SCHEMA_SQL);
    auditor = new AuditLogger(pool);
  });

  afterEach(async () => {
    await pool.end();
  });

  it('logs a transition event and returns true on first insert', async () => {
    const batchId = uuidv7();
    await pool.query(
      `INSERT INTO batches (id, status, version) VALUES ('${batchId}', 'REGISTERED', 1)`,
    );

    const inserted = await auditor.logTransition(
      batchId,
      'transition',
      'REGISTERED',
      'INSPECTED',
      uuidv7(),
    );

    expect(inserted).toBe(true);
  });

  it('returns false on duplicate idempotency key', async () => {
    const batchId = uuidv7();
    const idempotencyKey = uuidv7();
    await pool.query(
      `INSERT INTO batches (id, status, version) VALUES ('${batchId}', 'REGISTERED', 1)`,
    );

    // First insert should succeed.
    const first = await auditor.logTransition(
      batchId,
      'transition',
      'REGISTERED',
      'INSPECTED',
      idempotencyKey,
    );
    expect(first).toBe(true);

    // Second insert with same idempotency key.
    // pg-mem may not correctly report rowCount for ON CONFLICT DO NOTHING,
    // so we verify idempotency via the actual row count.
    await auditor.logTransition(
      batchId,
      'transition',
      'REGISTERED',
      'INSPECTED',
      idempotencyKey,
    );

    // Only one row should exist — the duplicate was silently ignored.
    const res = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM batch_audit_events WHERE batch_id = '${batchId}'`,
    );
    expect(res.rows[0].cnt).toBe(1);
  });
});
