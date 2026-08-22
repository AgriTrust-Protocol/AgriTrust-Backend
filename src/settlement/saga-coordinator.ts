import { randomUUID } from 'crypto';
import { SagaLogStore, SagaStatus } from '../database/saga_log';
import { CompensationHandler, CompensationResult } from './compensation-handler';
import { SagaContext, SagaStep, StepOutcome, idempotencyKey, withTimeout } from './saga-step';

export interface SagaDefinition {
  /** Stable name; used to reconstruct a saga for manual retry. */
  name: string;
  /** Ordered forward steps. Length must not exceed `maxSagaDepth`. */
  steps: SagaStep[];
}

export interface CoordinatorConfig {
  maxSagaDepth: number;
  stepTimeoutMs: number;
  sagaTimeoutMs: number;
  compensationRetries: number;
  compensationBackoffMs: number;
  maxConcurrentPerTenant: number;
}

/** Defaults encode the technical invariants from the feature spec. */
export const DEFAULT_CONFIG: CoordinatorConfig = {
  maxSagaDepth: 12,
  stepTimeoutMs: 30_000,
  sagaTimeoutMs: 300_000,
  compensationRetries: 3,
  compensationBackoffMs: 5_000,
  maxConcurrentPerTenant: 100,
};

export interface ExecuteOptions {
  /** Override the generated saga id (used by retry to resume the same saga). */
  sagaId?: string;
  /** Tenant the saga belongs to; gates the per-tenant concurrency cap. */
  tenantId?: string;
}

export interface SagaResult {
  sagaId: string;
  status: Extract<SagaStatus, 'completed' | 'compensated' | 'failed'>;
  context: SagaContext;
  failedStepId?: string;
  reason?: string;
  compensations?: CompensationResult[];
}

/**
 * Orchestrates a multi-step saga with compensating actions.
 *
 * FSM: Pending → Executing → { Completed | Compensating → (Compensated|Failed) }
 *
 * Guarantees:
 *  - per-step and whole-saga timeouts (effective per-step timeout shrinks as
 *    the saga deadline approaches);
 *  - at-most-once step execution via an idempotency key derived from
 *    `(saga_id, step_index)` and a `completed` log guard on retry;
 *  - on any step failure, completed steps are compensated in reverse order;
 *  - a per-tenant concurrency cap.
 */
export class SagaCoordinator {
  private readonly config: CoordinatorConfig;
  private readonly compensator: CompensationHandler;
  private readonly definitions = new Map<string, SagaDefinition>();
  /** In-process count of running sagas per tenant. */
  private readonly active = new Map<string, number>();

  constructor(
    private readonly log: SagaLogStore,
    config: Partial<CoordinatorConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.compensator = new CompensationHandler(this.log, {
      retries: this.config.compensationRetries,
      backoffMs: this.config.compensationBackoffMs,
      stepTimeoutMs: this.config.stepTimeoutMs,
    });
  }

  /** Registers a definition so failed sagas can be retried by name. */
  registerDefinition(def: SagaDefinition): void {
    this.definitions.set(def.name, def);
  }

  async execute(
    def: SagaDefinition,
    initialCtx: SagaContext = {},
    opts: ExecuteOptions = {},
  ): Promise<SagaResult> {
    if (def.steps.length === 0) {
      throw new Error('Saga definition must contain at least one step');
    }
    if (def.steps.length > this.config.maxSagaDepth) {
      throw new Error(
        `Saga depth ${def.steps.length} exceeds maximum of ${this.config.maxSagaDepth}`,
      );
    }

    this.registerDefinition(def);

    const tenantId = opts.tenantId ?? 'default';
    this.acquireSlot(tenantId);

    const sagaId = opts.sagaId ?? randomUUID();
    const ctx: SagaContext = { ...initialCtx };

    try {
      await this.log.createSaga(sagaId, def.name, tenantId, ctx);
      return await this.run(def, ctx, sagaId);
    } finally {
      this.releaseSlot(tenantId);
    }
  }

  /**
   * Re-runs a previously failed saga under its original id. Already-completed
   * steps are skipped via the at-most-once guard, so only the remaining work
   * (and, on repeated failure, compensation) is performed.
   */
  async retry(sagaId: string): Promise<SagaResult> {
    const { execution } = await this.log.getSaga(sagaId);
    if (!execution) {
      throw new Error(`Saga ${sagaId} not found`);
    }
    if (execution.status === 'completed') {
      return {
        sagaId,
        status: 'completed',
        context: execution.context ?? {},
      };
    }

    const def = this.definitions.get(execution.name);
    if (!def) {
      throw new Error(`No registered definition named "${execution.name}" to retry saga ${sagaId}`);
    }

    return this.execute(def, execution.context ?? {}, {
      sagaId,
      tenantId: execution.tenant_id,
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async run(def: SagaDefinition, ctx: SagaContext, sagaId: string): Promise<SagaResult> {
    await this.log.updateSagaStatus(sagaId, 'executing', ctx);

    const completed: SagaStep[] = [];
    const startedAt = Date.now();
    let failedStepId: string | undefined;
    let reason: string | undefined;

    for (let i = 0; i < def.steps.length; i++) {
      const step = def.steps[i];
      const elapsed = Date.now() - startedAt;
      const remaining = this.config.sagaTimeoutMs - elapsed;

      if (remaining <= 0) {
        failedStepId = step.id;
        reason = `Saga timed out after ${this.config.sagaTimeoutMs}ms`;
        break;
      }

      // At-most-once: skip steps already completed in a prior attempt.
      if (await this.log.isStepCompleted(sagaId, step.id)) {
        completed.push(step);
        continue;
      }

      const key = idempotencyKey(sagaId, i);
      await this.log.recordStep(sagaId, step.id, 'started', {
        idempotencyKey: key,
        stepIndex: i,
      });

      const effectiveTimeout = Math.min(this.config.stepTimeoutMs, remaining);
      let outcome: StepOutcome;
      try {
        outcome = await withTimeout(step.action(ctx), effectiveTimeout, `step:${step.id}`);
      } catch (e) {
        outcome = {
          ok: false,
          err: true,
          reason: e instanceof Error ? e.message : String(e),
        };
      }

      if (outcome.ok) {
        ctx[step.id] = outcome.result;
        await this.log.recordStep(sagaId, step.id, 'completed', {
          result: outcome.result as Record<string, unknown>,
        });
        completed.push(step);
      } else {
        failedStepId = step.id;
        reason = outcome.reason;
        await this.log.recordStep(sagaId, step.id, 'failed', null, reason);
        break;
      }
    }

    if (failedStepId === undefined) {
      await this.log.updateSagaStatus(sagaId, 'completed', ctx);
      return { sagaId, status: 'completed', context: ctx };
    }

    // Failure path: compensate completed steps in reverse.
    await this.log.updateSagaStatus(sagaId, 'compensating', ctx);
    const compensations = await this.compensator.compensate(sagaId, completed, ctx);

    const allCompensated = compensations.every((c) => c.success);
    const finalStatus: SagaStatus = allCompensated ? 'compensated' : 'failed';
    await this.log.updateSagaStatus(sagaId, finalStatus, ctx);

    return {
      sagaId,
      status: allCompensated ? 'compensated' : 'failed',
      context: ctx,
      failedStepId,
      reason,
      compensations,
    };
  }

  private acquireSlot(tenantId: string): void {
    const current = this.active.get(tenantId) ?? 0;
    if (current >= this.config.maxConcurrentPerTenant) {
      throw new Error(
        `Concurrent saga limit (${this.config.maxConcurrentPerTenant}) reached for tenant ${tenantId}`,
      );
    }
    this.active.set(tenantId, current + 1);
  }

  private releaseSlot(tenantId: string): void {
    const current = this.active.get(tenantId) ?? 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      this.active.delete(tenantId);
    } else {
      this.active.set(tenantId, next);
    }
  }
}
