import { describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler';
import { ScheduledJobRow } from '../../src/scheduler/types';

interface MockStore {
  reclaimExpiredLeases: ReturnType<typeof vi.fn>;
  claimNextDue: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  refreshLease: ReturnType<typeof vi.fn>;
  reschedule: ReturnType<typeof vi.fn>;
  schedule: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

function makeMockStore(): MockStore {
  return {
    reclaimExpiredLeases: vi.fn().mockResolvedValue(0),
    claimNextDue: vi.fn().mockResolvedValue(null),
    complete: vi.fn().mockResolvedValue(true),
    refreshLease: vi.fn().mockResolvedValue(true),
    reschedule: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
  };
}

function makeJob(overrides: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    job_id: 'job-1',
    type: 'delayed',
    payload: { operation: 'irrigation' },
    scheduled_at: new Date(),
    lease_until: null,
    lease_owner: 'scheduler-1',
    status: 'running',
    retry_count: 0,
    cron_expr: null,
    depends_on: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function driveOnce(scheduler: Scheduler): Promise<void> {
  return scheduler.drive();
}

describe('Scheduler', () => {
  it('does nothing when nothing is due', async () => {
    const store = makeMockStore();
    const scheduler = new Scheduler(store as never);
    await driveOnce(scheduler);
    expect(store.claimNextDue).toHaveBeenCalled();
  });

  it('runs a delayed job handler and completes it', async () => {
    const store = makeMockStore();
    store.claimNextDue.mockResolvedValue(makeJob());
    const handler = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler(store as never, { idlePollMs: 1_000_000 });
    scheduler.register('irrigation', handler);

    await driveOnce(scheduler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledWith('job-1', 'scheduler-1', 'succeeded');
  });

  it('short-circuits when no handler is registered', async () => {
    const store = makeMockStore();
    store.claimNextDue.mockResolvedValue(makeJob());
    const scheduler = new Scheduler(store as never, { idlePollMs: 1_000_000 });

    await driveOnce(scheduler);

    expect(store.complete).toHaveBeenCalledWith('job-1', 'scheduler-1', 'failed');
  });

  it('retries a failed job below the max retry bound and does not alert', async () => {
    const store = makeMockStore();
    store.get.mockResolvedValue(makeJob({ retry_count: 0 }));
    store.claimNextDue.mockResolvedValue(makeJob({ retry_count: 0 }));
    const scheduler = new Scheduler(store as never, {
      idlePollMs: 1_000_000,
      maxRetries: 3,
    });
    scheduler.register('irrigation', async () => {
      throw new Error('boom');
    });
    const alert = vi.fn();
    scheduler.onExhausted(alert);

    await driveOnce(scheduler);

    expect(store.complete).toHaveBeenCalledWith('job-1', 'scheduler-1', 'failed');
    expect(store.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ retry_count: 1 }),
      'pending',
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it('fires an alert once a job exhausts max retries', async () => {
    const store = makeMockStore();
    store.get.mockResolvedValue(makeJob({ retry_count: 3 }));
    store.claimNextDue.mockResolvedValue(makeJob({ retry_count: 3 }));
    const scheduler = new Scheduler(store as never, {
      idlePollMs: 1_000_000,
      maxRetries: 3,
    });
    scheduler.register('irrigation', async () => {
      throw new Error('boom');
    });
    const alert = vi.fn();
    scheduler.onExhausted(alert);

    await driveOnce(scheduler);

    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ job_id: 'job-1' }),
      'max_retries_exceeded',
    );
  });

  it('trips the circuit breaker after repeated failures', async () => {
    const store = makeMockStore();
    const scheduler = new Scheduler(store as never, {
      idlePollMs: 1_000_000,
      maxRetries: 3,
    });
    scheduler.register('irrigation', async () => {
      throw new Error('boom');
    });

    store.get.mockImplementation(async () => makeJob({ retry_count: 0 }));
    for (let i = 0; i < 3; i++) {
      store.claimNextDue.mockResolvedValue(makeJob());
      await driveOnce(scheduler);
    }

    const circuit = scheduler.getCircuit('irrigation');
    expect(circuit.getState()).toBe('open');
  });

  it('reschedules a successful cron job to its next run', async () => {
    const store = makeMockStore();
    store.claimNextDue.mockResolvedValue(
      makeJob({ job_id: 'cron-1', type: 'cron', cron_expr: '*/5 * * * *' }),
    );
    const now = new Date(Date.UTC(2026, 7, 28, 10, 3, 0));
    const scheduler = new Scheduler(store as never, {
      idlePollMs: 1_000_000,
      now: () => now,
    });
    scheduler.register('irrigation', async () => {});

    await driveOnce(scheduler);

    expect(store.reschedule).toHaveBeenCalledWith(
      'cron-1',
      new Date(Date.UTC(2026, 7, 28, 10, 5, 0)),
    );
    expect(store.complete).toHaveBeenCalledWith('cron-1', 'scheduler-1', 'succeeded');
  });

  it('releases dependents once an upstream job succeeds', async () => {
    const store = makeMockStore();
    store.claimNextDue.mockResolvedValue(makeJob({ job_id: 'up' }));
    store.list.mockResolvedValue([
      makeJob({ job_id: 'up', type: 'delayed', status: 'running' }),
      makeJob({
        job_id: 'down',
        type: 'dependency',
        status: 'pending',
        depends_on: ['up'],
        payload: { operation: 'harvest' },
      }),
    ]);
    const scheduler = new Scheduler(store as never, { idlePollMs: 1_000_000 });
    scheduler.register('irrigation', async () => {});

    await driveOnce(scheduler);

    expect(store.reschedule).toHaveBeenCalledWith('down', expect.any(Date));
  });
});
