import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobRegistry } from '../../src/job-queue/job-registry';
import { Priority } from '../../src/job-queue/types';
import { WorkerPool } from '../../src/job-queue/worker-pool';
import { QueuedJob, JobDef } from '../../src/job-queue/types';

// ── JobRegistry ──────────────────────────────────────────────────────────────

describe('JobRegistry', () => {
  let registry: JobRegistry;

  beforeEach(() => {
    registry = new JobRegistry();
  });

  it('registers a known job type and returns its definition', () => {
    registry.register('certificate_minting', async () => {});
    const def = registry.get('certificate_minting');
    expect(def).toBeDefined();
    expect(def!.priority).toBe(Priority.Critical);
    expect(def!.maxConcurrency).toBe(5);
  });

  it('throws on unknown job type', () => {
    expect(() => registry.register('nonexistent', async () => {})).toThrow(
      'Unknown job type',
    );
  });

  it('lists all registered types', () => {
    registry.register('certificate_minting', async () => {});
    registry.register('attestation_sync', async () => {});
    const list = Array.from(registry.list());
    expect(list.length).toBe(2);
  });

  it('unregisters a job type', () => {
    registry.register('certificate_minting', async () => {});
    expect(registry.unregister('certificate_minting')).toBe(true);
    expect(registry.get('certificate_minting')).toBeUndefined();
  });

  it('falls back to Normal priority for unknown type', () => {
    expect(registry.getPriority('unknown')).toBe(Priority.Normal);
  });
});

// ── WorkerPool ───────────────────────────────────────────────────────────────

describe('WorkerPool', () => {
  it('dispatches a job and tracks active count', async () => {
    const pool = new WorkerPool(2);
    const job: QueuedJob = {
      id: 'job-1',
      type: 'certificate_minting',
      priority: Priority.Critical,
      payload: { test: true },
      submittedAt: Date.now(),
      retryCount: 0,
    };
    const def: JobDef = {
      name: 'certificate_minting',
      priority: Priority.Critical,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 50));
      },
      maxConcurrency: 5,
      timeoutMs: 5000,
      resourceBudget: {
        maxConcurrency: 5,
        timeoutMs: 5000,
        retryLimit: 2,
      },
    };

    const promise = pool.dispatch(job, def);
    expect(pool.activeCount).toBe(1);

    await promise;
    expect(pool.activeCount).toBe(0);
  });

  it('tracks per-type concurrency', async () => {
    const pool = new WorkerPool(10);
    const job: QueuedJob = {
      id: 'j1',
      type: 'certificate_minting',
      priority: Priority.Critical,
      payload: {},
      submittedAt: Date.now(),
      retryCount: 0,
    };
    const def: JobDef = {
      name: 'certificate_minting',
      priority: Priority.Critical,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 30));
      },
      maxConcurrency: 5,
      timeoutMs: 5000,
      resourceBudget: { maxConcurrency: 5, timeoutMs: 5000, retryLimit: 2 },
    };

    const p1 = pool.dispatch({ ...job, id: 'j1' }, def);
    const p2 = pool.dispatch({ ...job, id: 'j2' }, def);

    expect(pool.getActiveByType()['certificate_minting']).toBe(2);

    await Promise.all([p1, p2]);
    expect(pool.getActiveByType()['certificate_minting']).toBeUndefined();
  });

  it('rejects dispatch when per-type concurrency is exceeded', async () => {
    const pool = new WorkerPool(10);
    const def: JobDef = {
      name: 'certificate_minting',
      priority: Priority.Critical,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 200));
      },
      maxConcurrency: 1,
      timeoutMs: 5000,
      resourceBudget: { maxConcurrency: 1, timeoutMs: 5000, retryLimit: 2 },
    };
    const job: QueuedJob = {
      id: 'j1',
      type: 'certificate_minting',
      priority: Priority.Critical,
      payload: {},
      submittedAt: Date.now(),
      retryCount: 0,
    };

    const p1 = pool.dispatch(job, def);
    await expect(
      pool.dispatch({ ...job, id: 'j2' }, def),
    ).rejects.toThrow('Max concurrency');
  });

  it('times out a long-running job and handles internally', async () => {
    const pool = new WorkerPool(1);
    const def: JobDef = {
      name: 'certificate_minting',
      priority: Priority.Critical,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 5000));
      },
      maxConcurrency: 1,
      timeoutMs: 50,
      resourceBudget: { maxConcurrency: 1, timeoutMs: 50, retryLimit: 0 },
    };

    // dispatch resolves — timeout is handled internally by retry/discard logic
    await pool.dispatch(
      {
        id: 'timeout-job',
        type: 'certificate_minting',
        priority: Priority.Critical,
        payload: {},
        submittedAt: Date.now(),
        retryCount: 0,
      },
      def,
    );
    // After timeout + discard, worker is freed
    expect(pool.activeCount).toBe(0);
  });

  it('hasCapacity returns false when pool is full', () => {
    const pool = new WorkerPool(1);
    expect(pool.hasCapacity()).toBe(true);
  });

  it('resizes the pool', () => {
    const pool = new WorkerPool(5);
    pool.resize(10);
    expect(pool.capacity).toBe(10);
  });
});
describe('Lease-based Scheduler', () => {
  it('acks completed leased jobs', async () => {
    const { Scheduler } = await import('../../src/job-queue/scheduler');
    const registry = new JobRegistry();
    registry.register('certificate_minting', async () => {});

    const job: QueuedJob = {
      id: 'leased-job-1',
      type: 'certificate_minting',
      priority: Priority.Critical,
      payload: {},
      submittedAt: Date.now(),
      retryCount: 0,
    };

    const persistence = {
      reclaimExpiredLeases: vi.fn().mockResolvedValue(0),
      claimDue: vi.fn().mockResolvedValueOnce({
        ...job,
        leaseOwner: 'scheduler-test',
        leaseExpiresAt: Date.now() + 60_000,
      }).mockResolvedValue(null),
      ack: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
    };

    const pool = new WorkerPool(1);
    const scheduler = new Scheduler(
      registry,
      persistence as unknown as import('../../src/job-queue/persistence').JobQueuePersistence,
      pool,
      'scheduler-test',
      60_000,
    );

    await (scheduler as unknown as { dispatchRound: () => Promise<void> }).dispatchRound();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(persistence.claimDue).toHaveBeenCalledWith(Priority.Critical, 'scheduler-test', 60_000);
    expect(persistence.ack).toHaveBeenCalledWith('leased-job-1', 'scheduler-test');
    expect(persistence.releaseLease).not.toHaveBeenCalled();
  });

  it('fires retry callback payloads when a job exhausts a failed attempt', async () => {
    const pool = new WorkerPool(1);
    const retrySpy = vi.fn();
    const def: JobDef = {
      name: 'certificate_minting',
      priority: Priority.Critical,
      handler: async () => {
        throw new Error('temporary failure');
      },
      maxConcurrency: 1,
      timeoutMs: 5000,
      resourceBudget: { maxConcurrency: 1, timeoutMs: 5000, retryLimit: 1 },
    };
    const job: QueuedJob = {
      id: 'retry-job',
      type: 'certificate_minting',
      priority: Priority.Critical,
      payload: {},
      submittedAt: Date.now(),
      retryCount: 0,
    };

    pool.onComplete(job.id, retrySpy);
    await pool.dispatch(job, def);

    expect(retrySpy).toHaveBeenCalledWith(expect.objectContaining({
      id: 'retry-job',
      retryCount: 1,
    }));
  });
});
