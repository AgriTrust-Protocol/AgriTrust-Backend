import { CircuitBreakerRegistry, CircuitOpenError } from './circuit_breaker';
import { DEFAULT_LEASE_REFRESH_MS, PostgresJobQueue } from './job_queue';
import { JobExecutionAlert, JobHandler, ScheduledJob } from './types';

export interface DistributedWorkerOptions {
  workerCount?: number;
  pollIntervalMs?: number;
  leaseRefreshMs?: number;
  onAlert?: (alert: JobExecutionAlert) => void | Promise<void>;
}

export class DistributedJobWorker {
  private running = false;
  private readonly workerCount: number;
  private readonly pollIntervalMs: number;
  private readonly leaseRefreshMs: number;
  private readonly onAlert?: (alert: JobExecutionAlert) => void | Promise<void>;
  private readonly loops: Promise<void>[] = [];

  constructor(
    private readonly queue: PostgresJobQueue,
    private readonly handlers: Map<string, JobHandler>,
    private readonly circuitBreakers = new CircuitBreakerRegistry(),
    options: DistributedWorkerOptions = {},
  ) {
    this.workerCount = options.workerCount ?? 5;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.leaseRefreshMs = options.leaseRefreshMs ?? DEFAULT_LEASE_REFRESH_MS;
    this.onAlert = options.onAlert;
  }

  start(instanceId = `${process.pid}`): void {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.workerCount; i++) {
      this.loops.push(this.loop(`${instanceId}-${i}`));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.loops.splice(0));
  }

  private async loop(workerId: string): Promise<void> {
    while (this.running) {
      const job = await this.queue.claimNextJob(workerId);
      if (!job) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      await this.execute(workerId, job);
    }
  }

  private async execute(workerId: string, job: ScheduledJob): Promise<void> {
    const handler = this.handlers.get(job.operation);
    if (!handler) {
      await this.handleFailure(workerId, job, new Error(`No handler registered for ${job.operation}`));
      return;
    }

    const refresh = setInterval(() => {
      this.queue.refreshLease(job.jobId, workerId).catch((err: unknown) => {
        console.error(`[scheduler] lease refresh failed for ${job.jobId}:`, err instanceof Error ? err.message : String(err));
      });
    }, this.leaseRefreshMs);

    try {
      this.circuitBreakers.assertCanExecute(job.operation);
      await this.queue.refreshLease(job.jobId, workerId);
      await handler(job);
      this.circuitBreakers.recordSuccess(job.operation);
      await this.queue.complete(job.jobId, workerId);
    } catch (err: unknown) {
      if (!(err instanceof CircuitOpenError)) this.circuitBreakers.recordFailure(job.operation);
      await this.handleFailure(workerId, job, err);
    } finally {
      clearInterval(refresh);
    }
  }

  private async handleFailure(workerId: string, job: ScheduledJob, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const status = await this.queue.failOrRetry(job, workerId, message);
    if (status === 'failed') {
      await this.onAlert?.({ jobId: job.jobId, operation: job.operation, reason: message, retryCount: job.retryCount + 1, timestamp: new Date() });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
