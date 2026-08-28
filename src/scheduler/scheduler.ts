import { DependencyResolver } from './dependency_resolver';
import { SchedulerCircuitBreaker } from './circuit_breaker';
import { nextRun, parseCron } from './cron_parser';
import { ScheduledJobStore } from './scheduled_job_store';
import {
  SCHEDULED_JOB_LEASE_REFRESH_MS,
  SCHEDULED_JOB_MAX_RETRIES,
  ScheduledJobHandler,
  ScheduledJobRow,
  SchedulerCircuitConfig,
} from './types';

export interface SchedulerOptions {
  idlePollMs?: number;
  leaseRefreshMs?: number;
  maxRetries?: number;
  circuitConfig?: Partial<SchedulerCircuitConfig>;
  now?: () => Date;
}

const DEFAULT_IDLE_POLL_MS = 1_000;

/**
 * Distributed job scheduler for farm operations (issue #168).
 *
 * Runs across many backend replicas. Each replica owns a poll loop that claims
 * a due `scheduled_jobs` row under a lease (`claimNextDue`, SKIP LOCKED),
 * executes a per-operation handler guarded by a circuit breaker, then marks the
 * job succeeded or failed. Successful cron jobs are re-armed for their next
 * run, and when a job finishes the dependents it unblocks are resolved and
 * enqueued.
 */
export class Scheduler {
  private readonly store: ScheduledJobStore;
  private readonly handlers = new Map<string, ScheduledJobHandler>();
  private readonly circuits = new Map<string, SchedulerCircuitBreaker>();
  private readonly dependencyResolver = new DependencyResolver();
  private readonly options: SchedulerOptions;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private completed = new Set<string>();
  private onAlert: (job: ScheduledJobRow, reason: string) => void = () => {};
  private readonly now: () => Date;

  constructor(store: ScheduledJobStore, options: SchedulerOptions = {}) {
    this.store = store;
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  /** Start the poll loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.drive();
      } catch (err) {
        console.error('[Scheduler] poll error:', err);
      }
      this.pollTimer = setTimeout(loop, this.options.idlePollMs ?? DEFAULT_IDLE_POLL_MS);
    };
    void loop();
  }

  /** Stop the poll loop. */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Register the executor for a farm operation. */
  register(operation: string, handler: ScheduledJobHandler): void {
    this.handlers.set(operation, handler);
  }

  /** Register an alert sink fired when a job exhausts its retries. */
  onExhausted(cb: (job: ScheduledJobRow, reason: string) => void): void {
    this.onAlert = cb;
  }

  /** The breaker guarding a specific operation. */
  getCircuit(operation: string): SchedulerCircuitBreaker {
    let circuit = this.circuits.get(operation);
    if (!circuit) {
      circuit = new SchedulerCircuitBreaker({
        failureThreshold: 3,
        windowMs: 5 * 60 * 1000,
        cooldownMs: 5 * 1000,
        now: () => this.now().getTime(),
        ...this.options.circuitConfig,
      });
      this.circuits.set(operation, circuit);
    }
    return circuit;
  }

  /** One poll pass: reclaim lapsed leases, then claim and run one due job. */
  async drive(): Promise<void> {
    const now = this.now();
    const reclaimed = await this.store.reclaimExpiredLeases(now);
    if (reclaimed > 0) {
      console.warn(`[Scheduler] reclaimed ${reclaimed} expired lease(s)`);
    }

    const job = await this.store.claimNextDue(`scheduler-${process.pid}-${Date.now()}`, now);
    if (!job) return;

    await this.runJob(job);
  }

  private async runJob(job: ScheduledJobRow): Promise<void> {
    const operation = String(job.payload?.operation ?? job.job_id);
    const handler = this.handlers.get(operation);

    if (!handler) {
      console.error(`[Scheduler] no handler registered for operation "${operation}"`);
      await this.store.complete(job.job_id, job.lease_owner ?? '', 'failed');
      return;
    }

    const circuit = this.getCircuit(operation);

    // Refresh the lease while running so long jobs never hit the 30s reclamation.
    const refresh = setInterval(async () => {
      try {
        await this.store.refreshLease(job.job_id, job.lease_owner ?? '', this.now());
      } catch (err) {
        console.error('[Scheduler] lease refresh error:', err);
      }
    }, this.options.leaseRefreshMs ?? SCHEDULED_JOB_LEASE_REFRESH_MS);

    try {
      await circuit.execute(async () => {
        await handler(job);
      });

      if (job.type === 'cron' && job.cron_expr != null) {
        const next = nextRun(parseCron(job.cron_expr), this.now());
        await this.store.reschedule(job.job_id, next);
      }
      await this.store.complete(job.job_id, job.lease_owner ?? '', 'succeeded');

      this.completed.add(job.job_id);
      await this.rescheduleDependents(job.job_id);
    } catch (err) {
      console.error(`[Scheduler] job ${job.job_id} failed:`, err);
      await this.handleFailure(job);
    } finally {
      clearInterval(refresh);
    }
  }

  private async handleFailure(job: ScheduledJobRow): Promise<void> {
    const maxRetries = this.options.maxRetries ?? SCHEDULED_JOB_MAX_RETRIES;
    let attempts = job.retry_count;
    try {
      const live = await this.store.get(job.job_id);
      if (live && live.retry_count > attempts) attempts = live.retry_count;
    } catch {
      /* best effort */
    }

    await this.store.complete(job.job_id, job.lease_owner ?? '', 'failed');

    if (attempts < maxRetries) {
      // Requeue as a fresh pending job with an incremented attempt count.
      await this.store.schedule(
        {
          job_id: job.job_id,
          type: job.type,
          payload: job.payload,
          scheduled_at: this.now(),
          cron_expr: job.cron_expr,
          depends_on: job.depends_on,
          retry_count: attempts + 1,
        },
        'pending',
      );
    } else {
      this.onAlert(job, 'max_retries_exceeded');
    }
  }

  private async rescheduleDependents(completedJobId: string): Promise<void> {
    const jobs = await this.store.list();
    const succeeded = new Set<string>(this.completed);
    for (const j of jobs) {
      if (j.status === 'succeeded') succeeded.add(j.job_id);
    }

    const runnable = this.dependencyResolver.resolve(
      completedJobId,
      new Map(jobs.map((j) => [j.job_id, j])),
      succeeded,
    );
    for (const depId of runnable) {
      await this.store.reschedule(depId, this.now());
    }
  }
}
