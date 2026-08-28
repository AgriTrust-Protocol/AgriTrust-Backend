import { newDb, DataType } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import type { ScheduledJobType } from '../../src/scheduler/types';
import { ScheduledJobStore } from '../../src/scheduler/scheduled_job_store';

// ── pg-mem setup ─────────────────────────────────────────────────────────────
//
// pg-mem cannot parse `SELECT ... FOR UPDATE SKIP LOCKED` (a hard limitation of
// its query planner). The production claim path uses that SQL via DB functions
// created in the migration, so here we register JS function stubs that mirror
// the migration's semantics and run them against the in-memory table — the same
// pattern the codebase uses elsewhere (see tests/unit/batchStatus.test.ts).

const TABLE_SQL = `
  CREATE TABLE scheduled_jobs (
      job_id       TEXT        PRIMARY KEY,
      type         TEXT        NOT NULL,
      payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
      scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_until  TIMESTAMPTZ,
      lease_owner  TEXT,
      status       TEXT        NOT NULL DEFAULT 'pending',
      retry_count  INTEGER     NOT NULL DEFAULT 0,
      cron_expr    TEXT,
      depends_on   TEXT[],
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

function createStore(): ScheduledJobStore {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true } as any);

  // Mirror `claim_next_scheduled_job(lease_until, worker_id)`: claim the oldest
  // due pending job, stamp the lease, and return the row.
  db.public.registerFunction({
    name: 'claim_next_scheduled_job',
    args: [DataType.timestamptz, DataType.text],
    returns: 'jsonb' as never,
    implementation: (leaseUntil: Date, workerId: string) => {
      const rows = db.public.many(
        `SELECT * FROM scheduled_jobs
          WHERE status = 'pending'
            AND scheduled_at <= NOW()
          ORDER BY scheduled_at ASC
          LIMIT 1`,
      );
      const job = rows[0];
      if (!job) return null;
      db.public.none(
        `UPDATE scheduled_jobs SET status='running', lease_until='${leaseUntil.toISOString()}'::timestamptz, lease_owner='${workerId}' WHERE job_id='${job.job_id}'`,
      );
      return { ...job, status: 'running', lease_until: leaseUntil, lease_owner: workerId };
    },
  });

  // Mirror `complete_scheduled_job(status, job_id, lease_owner)`.
  db.public.registerFunction({
    name: 'complete_scheduled_job',
    args: [DataType.text, DataType.text, DataType.text],
    returns: DataType.bool,
    implementation: (status: string, jobId: string, leaseOwner: string) => {
      const res = db.public.many(
        `UPDATE scheduled_jobs
            SET status='${status}', retry_count = retry_count + 1, lease_until=NULL, lease_owner=NULL
          WHERE job_id='${jobId}' AND lease_owner='${leaseOwner}'
          RETURNING job_id`,
      );
      return res.length > 0;
    },
  });

  // Mirror `refresh_scheduled_job_lease(lease_until, job_id, lease_owner)`.
  db.public.registerFunction({
    name: 'refresh_scheduled_job_lease',
    args: [DataType.timestamptz, DataType.text, DataType.text],
    returns: DataType.bool,
    implementation: (leaseUntil: Date, jobId: string, leaseOwner: string) => {
      const res = db.public.many(
        `UPDATE scheduled_jobs SET lease_until='${leaseUntil.toISOString()}'::timestamptz
          WHERE job_id='${jobId}' AND lease_owner='${leaseOwner}' AND status='running'
          RETURNING job_id`,
      );
      return res.length > 0;
    },
  });

  // Mirror `reclaim_expired_scheduled_jobs(now)`.
  db.public.registerFunction({
    name: 'reclaim_expired_scheduled_jobs',
    args: [DataType.timestamptz],
    returns: DataType.integer,
    implementation: (now: Date) => {
      const res = db.public.many(
        `UPDATE scheduled_jobs
            SET status='pending', lease_until=NULL, lease_owner=NULL
          WHERE status='running' AND lease_until < '${now.toISOString()}'::timestamptz
          RETURNING job_id`,
      );
      return res.length;
    },
  });

  db.public.none(TABLE_SQL);
  // pg-mem AST check is disabled so `NOW()` casts and interval comparisons work.
  (db as unknown as { public: { interactiveQuery: boolean } }).public.interactiveQuery = false;

  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as never;
  return new ScheduledJobStore(pool);
}

function makeJob(overrides: Partial<Record<string, unknown>> = {}): {
  job_id: string;
  type: ScheduledJobType;
  payload: Record<string, unknown>;
  scheduled_at: Date;
  cron_expr: string | null;
  depends_on: string[] | null;
  retry_count: number;
} {
  const base = {
    job_id: 'delay-1',
    type: 'delayed' as ScheduledJobType,
    payload: { operation: 'irrigation' },
    scheduled_at: new Date(Date.UTC(2026, 7, 28, 10, 0)),
    cron_expr: null,
    depends_on: null,
    retry_count: 0,
  };
  return { ...base, ...overrides } as never;
}

describe('ScheduledJobStore', () => {
  it('schedules and reads a job back', async () => {
    const store = createStore();
    await store.schedule(makeJob());
    const row = await store.get('delay-1');
    expect(row).not.toBeNull();
    expect(row!.job_id).toBe('delay-1');
    expect(row!.type).toBe('delayed');
    expect(row!.status).toBe('pending');
    expect(row!.payload).toEqual({ operation: 'irrigation' });
  });

  it('claims a due job and stamps the lease, leaving nothing else due', async () => {
    const store = createStore();
    await store.schedule(makeJob());
    const claimed = await store.claimNextDue('worker-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.lease_owner).toBe('worker-1');
    expect(claimed!.lease_until).not.toBeNull();
    expect(await store.claimNextDue('worker-2')).toBeNull();
  });

  it('completes a job only when owned by the lease holder', async () => {
    const store = createStore();
    await store.schedule(makeJob({ job_id: 'auth-2' }));
    await store.claimNextDue('worker-a');
    expect(await store.complete('auth-2', 'worker-wrong', 'succeeded')).toBe(false);
    expect(await store.complete('auth-2', 'worker-a', 'succeeded')).toBe(true);
    const row = await store.get('auth-2');
    expect(row!.status).toBe('succeeded');
  });

  it('reclaims an expired lease so another worker can run the job', async () => {
    const store = createStore();
    await store.schedule(makeJob({ job_id: 'reclaim-3' }));
    const claimed = (await store.claimNextDue('dead-worker'))!;
    expect(claimed!.status).toBe('running');

    // The dead worker never finishes; once its 30s lease lapses a live worker
    // reclaims the row and can run it.
    const afterLease = new Date(Date.now() + 60_000);
    expect(await store.reclaimExpiredLeases(afterLease)).toBeGreaterThan(0);
    const again = await store.claimNextDue('fresh-worker');
    expect(again).not.toBeNull();
    expect(again!.job_id).toBe('reclaim-3');
    expect(again!.lease_owner).toBe('fresh-worker');
  });

  it('reschedules a cron job to its next run', async () => {
    const store = createStore();
    await store.schedule(makeJob({ job_id: 'cron-4', type: 'cron', cron_expr: '*/5 * * * *' }));
    await store.reschedule('cron-4', new Date(Date.UTC(2026, 7, 28, 11, 0)));
    const row = await store.get('cron-4');
    expect(row!.status).toBe('pending');
    expect(row!.scheduled_at.toISOString()).toBe(
      new Date(Date.UTC(2026, 7, 28, 11, 0)).toISOString(),
    );
  });

  it('refreshes a lease so a running job does not get reclaimed', async () => {
    const store = createStore();
    await store.schedule(makeJob({ job_id: 'refresh-5' }));
    const claimed = (await store.claimNextDue('worker-r'))!;
    const now = new Date();
    expect(await store.refreshLease('refresh-5', 'worker-r', now)).toBe(true);
    expect((await store.get('refresh-5'))!.lease_until!.getTime()).toBe(
      new Date(now.getTime() + 30_000).getTime(),
    );
  });
});
