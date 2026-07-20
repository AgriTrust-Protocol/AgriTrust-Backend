import { BatchTransitionJob, RETRY_DELAY_MS } from '../types/batchStatus';

/**
 * Callback invoked when a retry job fires.
 * Receives the job and returns true if the transition succeeded.
 */
export type RetryHandler = (job: BatchTransitionJob) => Promise<boolean>;

/**
 * Simple in-memory queue-based retry engine for batch transitions.
 *
 * When an optimistic-lock conflict occurs during transitionBatch(), instead
 * of a blocking retry loop, the failed attempt is enqueued with a delay.
 * The worker re-reads the current state and validates the transition from
 * the ACTUAL current state, eliminating the stale-state replay bug.
 */
export class WorkflowEngine {
  private pending = new Map<string, NodeJS.Timeout>();
  private handler: RetryHandler | null = null;

  /**
   * Registers the handler that will process retry jobs.
   */
  onRetry(handler: RetryHandler): void {
    this.handler = handler;
  }

  /**
   * Enqueues a delayed batch transition retry.
   *
   * If a job for the same batchId is already pending, it is replaced
   * (debouncing multiple concurrent conflicts for the same batch).
   */
  enqueueRetry(job: BatchTransitionJob): void {
    // Debounce: replace any existing pending retry for the same batch.
    this.dequeueRetry(job.batchId);

    const delay = RETRY_DELAY_MS;
    const timeout = setTimeout(() => this.processRetry(job), delay);

    // Allow Node.js to exit even if retries are pending.
    timeout.unref();

    this.pending.set(job.batchId, timeout);
  }

  /**
   * Cancels a pending retry for the given batch (e.g., after a successful
   * transition from another source).
   */
  dequeueRetry(batchId: string): void {
    const existing = this.pending.get(batchId);
    if (existing) {
      clearTimeout(existing);
      this.pending.delete(batchId);
    }
  }

  /**
   * Returns the number of pending retries.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Cancels all pending retries. Useful for graceful shutdown.
   */
  shutdown(): void {
    for (const [batchId, timeout] of this.pending) {
      clearTimeout(timeout);
    }
    this.pending.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async processRetry(job: BatchTransitionJob): Promise<void> {
    this.pending.delete(job.batchId);

    if (!this.handler) {
      return;
    }

    try {
      const success = await this.handler(job);
      if (!success && job.attempt < job.maxRetries) {
        // Re-enqueue with incremented attempt.
        // NOTE: Use < (not <=) because attempt starts at 1, so with
        // maxRetries=3, attempts 1,2 retry and 3 is the last attempt.
        this.enqueueRetry({
          ...job,
          attempt: job.attempt + 1,
        });
      }
    } catch {
      // Only re-enqueue on transient failures (not permanent errors like
      // InvalidTransitionError which would never succeed).
      if (job.attempt < job.maxRetries) {
        this.enqueueRetry({
          ...job,
          attempt: job.attempt + 1,
        });
      }
    }
  }
}
