import { describe, it, expect, beforeEach } from 'vitest';
import { SagaCoordinator, SagaDefinition } from '../../src/settlement/saga-coordinator';
import { SagaLogStore } from '../../src/database/saga_log';
import { ok, err, SagaStep } from '../../src/settlement/saga-step';
import {
  EscrowEngine,
  buildSettlementSaga,
} from '../../src/settlement/escrow-engine';

/**
 * In-memory fake of SagaLogStore. Records every step transition so tests can
 * assert on the compensation chain without a live PostgreSQL instance.
 */
class FakeLogStore {
  executions = new Map<string, any>();
  logs: Array<{ sagaId: string; stepId: string; status: string; error?: string | null }> = [];

  async createSaga(sagaId: string, name: string, tenantId: string, context: any) {
    this.executions.set(sagaId, { saga_id: sagaId, name, tenant_id: tenantId, status: 'pending', context });
  }
  async updateSagaStatus(sagaId: string, status: string, context?: any) {
    const e = this.executions.get(sagaId);
    if (e) {
      e.status = status;
      if (context) e.context = context;
    }
  }
  async recordStep(sagaId: string, stepId: string, status: string, _payload?: any, error?: string | null) {
    this.logs.push({ sagaId, stepId, status, error });
  }
  async isStepCompleted(sagaId: string, stepId: string) {
    // Latest transition for this step must be `completed`.
    const forStep = this.logs.filter((l) => l.sagaId === sagaId && l.stepId === stepId);
    return forStep.length > 0 && forStep[forStep.length - 1].status === 'completed';
  }
  async getSaga(sagaId: string) {
    return {
      execution: this.executions.get(sagaId) ?? null,
      steps: this.logs.filter((l) => l.sagaId === sagaId),
    };
  }
  async countActiveByTenant() {
    return 0;
  }
}

// Fast config so retries/backoff don't slow the suite.
const FAST_CONFIG = {
  stepTimeoutMs: 500,
  sagaTimeoutMs: 5_000,
  compensationRetries: 3,
  compensationBackoffMs: 1,
};

function makeCoordinator(store: FakeLogStore) {
  return new SagaCoordinator(store as unknown as SagaLogStore, FAST_CONFIG);
}

describe('SagaCoordinator', () => {
  let store: FakeLogStore;
  let coordinator: SagaCoordinator;

  beforeEach(() => {
    store = new FakeLogStore();
    coordinator = makeCoordinator(store);
  });

  it('completes a saga when every step succeeds', async () => {
    const engine = new EscrowEngine();
    const def = buildSettlementSaga(engine, { escrowId: 'esc-1', amount: 100 });

    const result = await coordinator.execute(def, {}, { tenantId: 't1' });

    expect(result.status).toBe('completed');
    expect(engine.getState('esc-1')?.status).toBe('released');
    const statuses = store.logs.filter((l) => l.stepId === 'release').map((l) => l.status);
    expect(statuses).toContain('completed');
  });

  it('compensates completed steps in reverse order when a step fails', async () => {
    const compensated: string[] = [];
    const mkStep = (id: string, fail = false): SagaStep => ({
      id,
      action: async () => (fail ? err(`${id} failed`) : ok({ id })),
      compensate: async () => {
        compensated.push(id);
        return ok({ id });
      },
    });

    const def: SagaDefinition = {
      name: 'rollback-order',
      steps: [mkStep('a'), mkStep('b'), mkStep('c', true), mkStep('d')],
    };

    const result = await coordinator.execute(def, {}, { tenantId: 't1' });

    expect(result.status).toBe('compensated');
    expect(result.failedStepId).toBe('c');
    // a and b completed → compensated in reverse: b then a. d never ran.
    expect(compensated).toEqual(['b', 'a']);
  });

  it('runs the full compensation chain when a step fails on its 3rd invocation', async () => {
    let invocations = 0;
    const flakyStep: SagaStep = {
      id: 'flaky',
      action: async () => {
        invocations += 1;
        // Succeeds on calls 1 & 2, fails on the 3rd.
        return invocations >= 3 ? err('flaky failed on 3rd call') : ok({ invocations });
      },
      compensate: async () => ok({}),
    };

    const compensatedSteps: string[] = [];
    const precursor: SagaStep = {
      id: 'precursor',
      action: async () => ok({}),
      compensate: async () => {
        compensatedSteps.push('precursor');
        return ok({});
      },
    };
    const flakyCompensated: string[] = [];
    const flakyWithComp: SagaStep = {
      ...flakyStep,
      compensate: async () => {
        flakyCompensated.push('flaky');
        return ok({});
      },
    };

    const def: SagaDefinition = {
      name: 'flaky-saga',
      steps: [precursor, flakyWithComp],
    };

    // 1st run: flaky is call #1 → ok. Saga completes.
    const r1 = await coordinator.execute(def, {}, { tenantId: 't1', sagaId: 'saga-A' });
    expect(r1.status).toBe('completed');

    // 2nd run (fresh saga): flaky is call #2 → ok. Completes again.
    const r2 = await coordinator.execute(def, {}, { tenantId: 't1', sagaId: 'saga-B' });
    expect(r2.status).toBe('completed');

    // 3rd run (fresh saga): flaky is call #3 → fails → full compensation chain.
    const r3 = await coordinator.execute(def, {}, { tenantId: 't1', sagaId: 'saga-C' });
    expect(r3.status).toBe('compensated');
    expect(r3.failedStepId).toBe('flaky');
    // Only `precursor` had completed → it must be compensated. flaky never
    // completed, so its compensation must NOT run.
    expect(compensatedSteps).toEqual(['precursor']);
    expect(flakyCompensated).toEqual([]);
    expect(invocations).toBe(3);
  });

  it('retries a compensation up to 3 times then logs compensation_failed', async () => {
    let compAttempts = 0;
    const def: SagaDefinition = {
      name: 'comp-retry',
      steps: [
        {
          id: 'x',
          action: async () => ok({}),
          compensate: async () => {
            compAttempts += 1;
            return err('compensation keeps failing');
          },
        },
        {
          id: 'y',
          action: async () => err('y fails to trigger compensation'),
          compensate: async () => ok({}),
        },
      ],
    };

    const result = await coordinator.execute(def, {}, { tenantId: 't1' });

    expect(result.status).toBe('failed');
    expect(compAttempts).toBe(3);
    expect(store.logs.some((l) => l.stepId === 'x' && l.status === 'compensation_failed')).toBe(true);
  });

  it('resumes an interrupted run on retry, skipping completed steps', async () => {
    let aRuns = 0;
    let bRuns = 0;
    const def: SagaDefinition = {
      name: 'resumable',
      steps: [
        {
          id: 'a',
          action: async () => {
            aRuns += 1;
            return ok({});
          },
          compensate: async () => ok({}),
        },
        {
          id: 'b',
          action: async () => {
            bRuns += 1;
            return ok({});
          },
          compensate: async () => ok({}),
        },
      ],
    };
    coordinator.registerDefinition(def);

    // Simulate a crash: `a` completed and was logged, but the process died
    // before `b` ran. The saga is left mid-flight in `executing`.
    await store.createSaga('res-1', 'resumable', 't1', {});
    await store.updateSagaStatus('res-1', 'executing', {});
    await store.recordStep('res-1', 'a', 'started');
    await store.recordStep('res-1', 'a', 'completed');

    const retry = await coordinator.retry('res-1');

    expect(retry.status).toBe('completed');
    expect(aRuns).toBe(0); // skipped — its latest status was `completed`
    expect(bRuns).toBe(1); // resumed forward
  });

  it('rejects sagas that exceed the maximum depth of 12 steps', async () => {
    const steps: SagaStep[] = Array.from({ length: 13 }, (_, i) => ({
      id: `s${i}`,
      action: async () => ok({}),
      compensate: async () => ok({}),
    }));
    await expect(
      coordinator.execute({ name: 'too-deep', steps }, {}, { tenantId: 't1' }),
    ).rejects.toThrow(/exceeds maximum/);
  });

  it('enforces the per-tenant concurrency cap', async () => {
    const limited = new SagaCoordinator(store as unknown as SagaLogStore, {
      ...FAST_CONFIG,
      maxConcurrentPerTenant: 1,
    });

    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const slowDef: SagaDefinition = {
      name: 'slow',
      steps: [
        {
          id: 'wait',
          action: async () => {
            await gate;
            return ok({});
          },
          compensate: async () => ok({}),
        },
      ],
    };

    const inFlight = limited.execute(slowDef, {}, { tenantId: 'busy' });
    // Second concurrent saga for the same tenant must be rejected.
    await expect(
      limited.execute(slowDef, {}, { tenantId: 'busy' }),
    ).rejects.toThrow(/Concurrent saga limit/);

    releaseGate();
    await inFlight;
  });
});
