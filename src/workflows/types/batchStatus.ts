/**
 * Batch Status Workflow Types
 *
 * Defines the core data structures for the batch status transition system
 * with optimistic locking, idempotency, and at-most-once guarantees.
 */

/** Valid batch statuses in the lifecycle DAG. */
export type BatchStatus =
  | 'REGISTERED'
  | 'INSPECTED'
  | 'CERTIFIED'
  | 'SHIPPED'
  | 'DELIVERED';

/** A batch row as stored in PostgreSQL. */
export interface BatchRow {
  id: string;
  status: BatchStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Parameters for a batch transition request. */
export interface TransitionRequest {
  batchId: string;
  targetStatus: BatchStatus;
}

/** Outcome of a transition attempt. */
export interface TransitionResult {
  success: boolean;
  batchId: string;
  previousStatus: BatchStatus | null;
  currentStatus: BatchStatus | null;
  idempotencyKey: string;
  /** HTTP-like status code: 200 = transition applied, 202 = already processed */
  code: 200 | 202 | 409 | 422;
  reason?: string;
}

/** A batch transition job enqueued for retry after OCC failure. */
export interface BatchTransitionJob {
  batchId: string;
  targetStatus: BatchStatus;
  idempotencyKey: string;
  attempt: number;
  maxRetries: number;
  createdAt: number;
}

/** Maximum retry attempts for OCC conflicts. */
export const MAX_RETRIES = 3;

/** Delay between OCC retries in milliseconds. */
export const RETRY_DELAY_MS = 5_000;
