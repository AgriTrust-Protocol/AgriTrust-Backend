import {
  Priority,
  PRIORITY_WEIGHTS,
  TICK_INTERVAL_MS,
  QueuedJob,
} from './types';
import { JobRegistry } from './job-registry';
import { JobQueuePersistence } from './persistence';
import { WorkerPool } from './worker-pool';
import { jobDeadLetterTotal, jobRetryTotal } from '../api/metrics/registry';

/**
 * Weighted fair queue scheduler using deficit round-robin.
 *
 * Every tick (100ms) it draws from each priority level proportionally to its
 * configured weight.  Each level gets a per-tick deficit counter; unspent
 * deficit carries forward so no priority is starved across ticks.
 */
export class Scheduler {
  private readonly registry: JobRegistry;
  private readonly persistence: JobQueuePersistence;
  private readonly workerPool: WorkerPool;
  private deficits: Record<number, number>;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    registry: JobRegistry,
    persistence: JobQueuePersistence,
    workerPool: WorkerPool,
  ) {
    this.registry = registry;
    this.persistence = persistence;
    this.workerPool = workerPool;
    this.deficits = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  }

  /** Start the scheduler tick loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  /** Stop the scheduler tick loop. */
  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Single scheduling tick — deficit round-robin dispatch. */
  private async tick(): Promise<void> {
    try {
      await this.dispatchRound();
    } catch (err) {
      console.error('[Scheduler] tick error:', err);
    }
  }

  /** One round of deficit round-robin across all 5 priority levels. */
  private async dispatchRound(): Promise<void> {
    // Quantum = 1 job per level per tick, weighted by proportion.
    // Give each level its deficit slice, then try to dequeue up to that many.
    const sortedLevels = [5, 4, 3, 2, 1] as Priority[];

    for (const level of sortedLevels) {
      const weight = PRIORITY_WEIGHTS[level];
      if (weight === 0) continue;

      // Add weight-quantum to deficit bucket.
      this.deficits[level] += weight * 3; // up to 3 jobs per tick for critical

      // Keep dispatching from this level until deficit runs dry.
      while (this.deficits[level] >= 1 && this.workerPool.hasCapacity()) {
        const job = await this.persistence.dequeue(level);
        if (!job) break; // level empty

        this.deficits[level] -= 1;
        const def = this.registry.get(job.type);
        if (!def) {
          console.warn(`[Scheduler] Unknown job type "${job.type}" — sending to dead letter queue`);
          await this.persistence.deadLetter({
            ...job,
            failedAt: Date.now(),
            reason: 'unknown_type',
            errorMessage: `Unknown job type "${job.type}"`,
            attempts: (job.retryCount ?? 0) + 1,
          });
          jobDeadLetterTotal.inc({ type: job.type, reason: 'unknown_type' });
          continue;
        }

        this.workerPool.onComplete(job.id, (completion) => {
          if (completion.status === 'retry') {
            jobRetryTotal.inc({ type: completion.retryJob.type });
            this.persistence.enqueue(completion.retryJob).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[Scheduler] retry enqueue failed for ${job.id}: ${msg}`);
            });
            return;
          }

          if (completion.status === 'dead-letter') {
            jobDeadLetterTotal.inc({
              type: completion.deadLetterJob.type,
              reason: completion.deadLetterJob.reason,
            });
            this.persistence.deadLetter(completion.deadLetterJob).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[Scheduler] dead-letter write failed for ${job.id}: ${msg}`);
            });
          }
        });

        this.workerPool.dispatch(job, def).catch((err: unknown) => {
          this.workerPool.removeOnComplete(job.id);
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Scheduler] dispatch error for ${job.id}: ${msg}`);
          this.persistence.enqueue({
            ...job,
            submittedAt: Date.now(),
          }).catch((enqueueErr: unknown) => {
            const enqueueMsg = enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr);
            console.error(`[Scheduler] dispatch requeue failed for ${job.id}: ${enqueueMsg}`);
          });
        });
      }
    }
  }

  /** Force-rebalance deficits — reset all to 0. */
  rebalance(): void {
    this.deficits = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  }

  /** Current deficit counters (for admin inspection). */
  getDeficits(): Record<number, number> {
    return { ...this.deficits };
  }

  /** Whether the scheduler is running. */
  isRunning(): boolean {
    return this.running;
  }
}
