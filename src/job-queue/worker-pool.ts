import { ActiveJob, DEFAULT_JOB_TIMEOUT_MS, DEFAULT_RETRY_LIMIT, DEFAULT_WORKER_POOL_SIZE, JobCompletion, JobDef, QueuedJob } from './types';

/**
 * Manages the lifecycle and concurrency of running jobs.
 *
 * Maintains a Map<jobType, number> of active counts and refuses dispatch when
 * a job type's maxConcurrency is reached.  Runs job functions with timeout and
 * automatic retry.
 */
export class WorkerPool {
  private readonly active = new Map<string, ActiveJob>();
  private readonly activeCountByType = new Map<string, number>();
  private poolSize: number;
  private onCompleteCallbacks: Array<{ jobId: string; cb: (completion: JobCompletion) => void }> = [];

  constructor(poolSize: number = DEFAULT_WORKER_POOL_SIZE) {
    this.poolSize = poolSize;
  }

  /** Total concurrent worker capacity. */
  get capacity(): number {
    return this.poolSize;
  }

  /** Number of currently active workers. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Whether there is capacity to dispatch more jobs. */
  hasCapacity(): boolean {
    return this.active.size < this.poolSize;
  }

  /** Active count per job type. */
  getActiveByType(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [type, count] of this.activeCountByType) {
      result[type] = count;
    }
    return result;
  }

  /** Get the list of currently active jobs. */
  listActive(): ActiveJob[] {
    return Array.from(this.active.values());
  }

  /**
   * Dispatch a queued job to the worker pool.
   * Throws if the job type's maxConcurrency would be exceeded.
   */
  async dispatch(job: QueuedJob, def: JobDef): Promise<void> {
    // Type-level concurrency gate.
    const current = this.activeCountByType.get(job.type) ?? 0;
    if (current >= def.maxConcurrency) {
      // Re-enqueue — another worker will pick it up later.
      throw new Error(`Max concurrency (${def.maxConcurrency}) reached for ${job.type}`);
    }

    const workerId = `worker-${job.id.slice(0, 8)}`;
    const active: ActiveJob = {
      ...job,
      startedAt: Date.now(),
      workerId,
    };

    this.active.set(job.id, active);
    this.activeCountByType.set(job.type, current + 1);

    try {
      await this.runWithTimeout(def.handler, job.payload, def.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
      this.fireOnComplete(job.id, { status: 'succeeded' });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const msg = error.message;
      console.error(`[WorkerPool] Job ${job.id} (${job.type}) failed: ${msg}`);

      if ((job.retryCount ?? 0) < (def.resourceBudget?.retryLimit ?? DEFAULT_RETRY_LIMIT)) {
        // Re-enqueue with incremented retry count.
        const retryJob: QueuedJob = {
          ...job,
          retryCount: (job.retryCount ?? 0) + 1,
          submittedAt: Date.now(),
        };
        // We need to re-enqueue to persistence — hook this externally.
        console.log(`[WorkerPool] Retrying job ${job.id} (attempt ${retryJob.retryCount})`);
        this.fireOnComplete(job.id, { status: 'retry', retryJob, error });
      } else {
        console.error(`[WorkerPool] Job ${job.id} exhausted retries — sending to dead letter queue`);
        this.fireOnComplete(job.id, {
          status: 'dead-letter',
          deadLetterJob: {
            ...job,
            failedAt: Date.now(),
            reason: msg.startsWith('Job timed out after') ? 'timeout' : 'handler_error',
            errorMessage: msg,
            attempts: (job.retryCount ?? 0) + 1,
          },
        });
      }
    } finally {
      this.active.delete(job.id);
      const updated = (this.activeCountByType.get(job.type) ?? 1) - 1;
      if (updated <= 0) {
        this.activeCountByType.delete(job.type);
      } else {
        this.activeCountByType.set(job.type, updated);
      }
    }
  }

  /**
   * Run a handler with a timeout.  If the handler doesn't resolve within
   * `timeoutMs`, it is rejected.
   */
  private async runWithTimeout(
    handler: (payload: unknown) => Promise<void>,
    payload: unknown,
    timeoutMs: number,
  ): Promise<void> {
    const timer = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`Job timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    await Promise.race([handler(payload), timer]);
  }

  /** Register a callback to fire when a job completes or fails. */
  onComplete(jobId: string, cb: (completion: JobCompletion) => void): void {
    this.onCompleteCallbacks.push({ jobId, cb });
  }

  /** Remove a completion callback when dispatch fails before a job starts. */
  removeOnComplete(jobId: string): void {
    this.onCompleteCallbacks = this.onCompleteCallbacks.filter((c) => c.jobId !== jobId);
  }

  private fireOnComplete(jobId: string, completion: JobCompletion): void {
    const idx = this.onCompleteCallbacks.findIndex((c) => c.jobId === jobId);
    if (idx !== -1) {
      this.onCompleteCallbacks[idx].cb(completion);
      this.onCompleteCallbacks.splice(idx, 1);
    }
  }

  /** Resize the worker pool (adjusted live). */
  resize(newSize: number): void {
    this.poolSize = Math.max(1, newSize);
  }
}
