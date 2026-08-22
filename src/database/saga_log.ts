import { Pool } from 'pg';

/**
 * Persistence layer for saga orchestration.
 *
 * Two tables back the coordinator:
 *  - `saga_executions` — one row per saga, holding the FSM status, the saga
 *    definition name (so a failed saga can be reconstructed for manual retry)
 *    and the latest context snapshot.
 *  - `saga_log`        — append-only audit trail of every step transition
 *    (`saga_id, step_id, status, payload, error, created_at`).
 */

export type SagaStatus =
  'pending' | 'executing' | 'completed' | 'compensating' | 'compensated' | 'failed';

export type StepStatus =
  'started' | 'completed' | 'failed' | 'compensating' | 'compensated' | 'compensation_failed';

export interface SagaExecutionRow {
  saga_id: string;
  name: string;
  tenant_id: string;
  status: SagaStatus;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SagaLogRow {
  id: string;
  saga_id: string;
  step_id: string;
  status: StepStatus;
  payload: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
}

export interface SagaView {
  execution: SagaExecutionRow | null;
  steps: SagaLogRow[];
}

export class SagaLogStore {
  constructor(private readonly pool: Pool) {}

  /** Registers a new saga in the `pending` state. */
  async createSaga(
    sagaId: string,
    name: string,
    tenantId: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO saga_executions (saga_id, name, tenant_id, status, context)
       VALUES ($1, $2, $3, 'pending', $4)
       ON CONFLICT (saga_id) DO NOTHING`,
      [sagaId, name, tenantId, JSON.stringify(context)],
    );
  }

  /** Transitions the saga-level FSM status and snapshots the context. */
  async updateSagaStatus(
    sagaId: string,
    status: SagaStatus,
    context?: Record<string, unknown>,
  ): Promise<void> {
    if (context) {
      await this.pool.query(
        `UPDATE saga_executions
            SET status = $2, context = $3, updated_at = NOW()
          WHERE saga_id = $1`,
        [sagaId, status, JSON.stringify(context)],
      );
    } else {
      await this.pool.query(
        `UPDATE saga_executions
            SET status = $2, updated_at = NOW()
          WHERE saga_id = $1`,
        [sagaId, status],
      );
    }
  }

  /** Appends an immutable step-transition record to the execution log. */
  async recordStep(
    sagaId: string,
    stepId: string,
    status: StepStatus,
    payload?: Record<string, unknown> | null,
    error?: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO saga_log (saga_id, step_id, status, payload, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [sagaId, stepId, status, payload != null ? JSON.stringify(payload) : null, error ?? null],
    );
  }

  /**
   * At-most-once guard. Returns true when the step's *latest* transition for
   * this saga is `completed` — i.e. its forward action is still in effect and
   * has not since been compensated. This lets a retry resume an interrupted
   * run (skipping completed steps) while still re-running steps that were
   * rolled back by a prior compensation.
   */
  async isStepCompleted(sagaId: string, stepId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT status FROM saga_log
        WHERE saga_id = $1 AND step_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [sagaId, stepId],
    );
    return res.rows[0]?.status === 'completed';
  }

  /** Loads the saga execution plus its full ordered step log for debugging. */
  async getSaga(sagaId: string): Promise<SagaView> {
    const execRes = await this.pool.query(
      `SELECT saga_id, name, tenant_id, status, context, created_at, updated_at
         FROM saga_executions WHERE saga_id = $1`,
      [sagaId],
    );
    const stepsRes = await this.pool.query(
      `SELECT id, saga_id, step_id, status, payload, error, created_at
         FROM saga_log WHERE saga_id = $1
        ORDER BY created_at ASC, id ASC`,
      [sagaId],
    );
    return {
      execution: execRes.rows[0] ?? null,
      steps: stepsRes.rows,
    };
  }

  /** Counts in-flight sagas for a tenant (used to enforce concurrency caps). */
  async countActiveByTenant(tenantId: string): Promise<number> {
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS count
         FROM saga_executions
        WHERE tenant_id = $1 AND status IN ('pending', 'executing', 'compensating')`,
      [tenantId],
    );
    return Number(res.rows[0]?.count ?? 0);
  }
}
