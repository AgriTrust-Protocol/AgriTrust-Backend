/** Priority levels — 5 (critical) … 1 (background). */
export enum Priority {
  Background = 1,
  Low = 2,
  Normal = 3,
  High = 4,
  Critical = 5,
}

/** Weight fraction (0–1) per priority level for weighted fair queueing. */
export const PRIORITY_WEIGHTS: Record<Priority, number> = {
  [Priority.Background]: 0.05,
  [Priority.Low]: 0.1,
  [Priority.Normal]: 0.2,
  [Priority.High]: 0.25,
  [Priority.Critical]: 0.4,
};

/** Default concurrency caps per job type at each priority. */
export interface ResourceBudget {
  maxConcurrency: number;
  timeoutMs: number;
  retryLimit: number;
}

export interface JobHandler {
  (payload: unknown): Promise<void>;
}

export interface JobDef {
  name: string;
  priority: Priority;
  handler: JobHandler;
  maxConcurrency: number;
  timeoutMs: number;
  resourceBudget: ResourceBudget;
}

/** A queued job waiting to be dispatched. */
export interface QueuedJob {
  id: string;
  type: string;
  priority: Priority;
  payload: unknown;
  submittedAt: number; // unix ms
  retryCount: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  lastClaimedAt?: number;
}

/** An active (running) job. */
export interface ActiveJob extends QueuedJob {
  startedAt: number;
  workerId: string;
}

/** Reason a job moved to the dead letter queue. */
export type DeadLetterReason = 'handler_error' | 'timeout' | 'unknown_type' | 'dispatch_rejected';

/** A terminally failed job retained for inspection and replay. */
export interface DeadLetterJob extends QueuedJob {
  failedAt: number;
  reason: DeadLetterReason;
  errorMessage: string;
  attempts: number;
}

/** Worker completion outcome used by the scheduler to retry or dead-letter. */
export type JobCompletion =
  | { status: 'succeeded' }
  | { status: 'retry'; retryJob: QueuedJob; error: Error }
  | { status: 'dead-letter'; deadLetterJob: DeadLetterJob };

/** Admin-visible queue snapshot. */
export interface QueueSnapshot {
  byPriority: Record<string, QueuedJob[]>;
  active: ActiveJob[];
  workerUtilisation: Record<string, number>;
}

/** Maximum queued jobs before back-pressure kicks in. */
export const MAX_QUEUED_JOBS = 50_000;

/** Default worker pool size. */
export const DEFAULT_WORKER_POOL_SIZE = 20;

/** Schedule tick interval in ms. */
export const TICK_INTERVAL_MS = 100;

/** Job timeout in ms. */
export const DEFAULT_JOB_TIMEOUT_MS = 300_000;

/** Max retries per job. */
export const DEFAULT_RETRY_LIMIT = 2;

/** Maximum dead-letter entries returned by admin APIs by default. */
export const DEFAULT_DLQ_LIST_LIMIT = 100;

/** Default job lease duration in ms before it is reclaimed. */
export const DEFAULT_JOB_LEASE_MS = 30_000;
