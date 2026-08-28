/**
 * Types for the distributed job scheduler (issue #168).
 *
 * The scheduler orchestrates three kinds of farm-operation jobs that are not
 * suited to the real-time Redis priority queue because their execution is
 * governed by time or by the completion of other jobs:
 *
 *   - `cron`       – runs on a standard 5-field cron expression.
 *   - `delayed`    – runs once, at a specific timestamp.
 *   - `dependency` – runs only after a set of upstream jobs have succeeded.
 */

/** Which scheduling rule a job record represents. */
export type ScheduledJobType = 'cron' | 'delayed' | 'dependency';

/** Terminal + running states a scheduled job row can live in. */
export type ScheduledJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/**
 * The durable `scheduled_jobs` row. `scheduled_at` is the next time the job
 * becomes due. Lease columns are only populated while a worker owns the job
 * (30s TTL, refreshed every 10s).
 */
export interface ScheduledJob {
  job_id: string;
  type: ScheduledJobType;
  payload: Record<string, unknown>;
  scheduled_at: Date;
  lease_until: Date | null;
  lease_owner: string | null;
  status: ScheduledJobStatus;
  retry_count: number;
  cron_expr: string | null;
  depends_on: string[] | null;
  created_at: Date;
  updated_at: Date;
}

/** A job read back from the store after a lease claim. */
export type ScheduledJobRow = ScheduledJob;

/** Payload shape expected by the worker for a cron-triggered farm operation. */
export interface CronJobPayload {
  operation: string;
  [key: string]: unknown;
}

/** Payload shape for a delayed, one-shot job. */
export interface DelayedJobPayload {
  operation: string;
  [key: string]: unknown;
}

/** Payload shape for a dependency-triggered job. */
export interface DependencyJobPayload {
  operation: string;
  upstream: string[];
  [key: string]: unknown;
}

/** Accepted result from a scheduled job handler. */
export interface ScheduledJobResult {
  status?: 'succeeded' | 'failed';
  /** Re-arm a cron/delayed job for another run. */
  schedule_next?: boolean;
}

/** Contract implemented by whatever executes one scheduled job. */
export interface ScheduledJobHandler {
  (job: ScheduledJobRow): Promise<ScheduledJobResult | void>;
}

/** Circuit breaker lifecycle states from the issue spec. */
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

/** Configuration for one operation's circuit breaker. */
export interface SchedulerCircuitConfig {
  /** Trip after this many failures inside the window. */
  failureThreshold: number;
  /** Sliding window length (ms). */
  windowMs: number;
  /** How long the breaker stays Open before probing (ms). */
  cooldownMs: number;
  now?: () => number;
}

/** Lease lifecycle constants from the issue's technical invariants. */
export const SCHEDULED_JOB_LEASE_MS = 30_000;
export const SCHEDULED_JOB_LEASE_REFRESH_MS = 10_000;
export const SCHEDULED_JOB_MAX_RETRIES = 3;
