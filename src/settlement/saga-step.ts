import * as crypto from 'crypto';

/**
 * Saga step primitives.
 *
 * Every step in a saga exposes a forward `action` and an idempotent
 * `compensate`. Both return a discriminated `StepOutcome` so the coordinator
 * can branch on success/failure without relying on thrown exceptions
 * (though thrown errors are also caught and normalised to an `err` outcome).
 */

export type StepOk<R = unknown> = { ok: true; result: R };
export type StepErr = { ok: false; err: true; reason: string };
export type StepOutcome<R = unknown> = StepOk<R> | StepErr;

/** Mutable bag threaded through every step's action/compensate. */
export interface SagaContext {
  [key: string]: unknown;
}

export type ActionFn = (ctx: SagaContext) => Promise<StepOutcome>;
export type CompensateFn = (ctx: SagaContext) => Promise<StepOutcome>;

export interface SagaStep {
  /** Stable identifier, unique within a saga definition. */
  id: string;
  /** Forward transaction. */
  action: ActionFn;
  /** Compensating (rollback) transaction. Must be best-effort & idempotent. */
  compensate: CompensateFn;
}

/** Convenience constructors for the outcome union. */
export const ok = <R>(result: R): StepOk<R> => ({ ok: true, result });
export const err = (reason: string): StepErr => ({ ok: false, err: true, reason });

/**
 * Derives the at-most-once idempotency key for a step from
 * `(saga_id, step_index)` as required by the execution invariants.
 */
export function idempotencyKey(sagaId: string, stepIndex: number): string {
  return crypto.createHash('sha256').update(`${sagaId}:${stepIndex}`).digest('hex');
}

/**
 * Races a promise against a timeout. Rejects with a labelled error when the
 * deadline elapses so the coordinator can record a timeout failure.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Promise-based sleep used for compensation backoff. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
