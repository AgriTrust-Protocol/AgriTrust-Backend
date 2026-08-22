import { SagaDefinition } from './saga-coordinator';
import { SagaContext, StepOutcome, ok, err } from './saga-step';

/**
 * Minimal escrow lifecycle used to wire the settlement saga together.
 * Extended to conditionally execute variant settlement conditions based on Canary variants.
 */

export type EscrowStatus = 'none' | 'held' | 'verified' | 'released' | 'reversed';

export interface EscrowRecord {
  escrowId: string;
  amount: number;
  status: EscrowStatus;
  variantExecuted?: string; // Tracks which variant processed this transaction
}

export class EscrowEngine {
  private readonly store = new Map<string, EscrowRecord>();

  getState(escrowId: string): EscrowRecord | undefined {
    return this.store.get(escrowId);
  }

  /** Forward: place a hold on the escrowed funds. */
  async hold(escrowId: string, amount: number): Promise<StepOutcome<EscrowRecord>> {
    if (amount <= 0) {
      return err(`Invalid escrow amount: ${amount}`);
    }
    const record: EscrowRecord = { escrowId, amount, status: 'held' };
    this.store.set(escrowId, record);
    return ok(record);
  }

  /** Compensation for `hold`: drop the hold. Idempotent. */
  async releaseHold(escrowId: string): Promise<StepOutcome<EscrowRecord>> {
    const record = this.store.get(escrowId);
    if (!record) {
      return ok({ escrowId, amount: 0, status: 'none' });
    }
    record.status = 'none';
    return ok(record);
  }

  /** Forward: verify the held funds satisfy settlement preconditions. */
  async verify(escrowId: string, variantName = 'baseline'): Promise<StepOutcome<EscrowRecord>> {
    const record = this.store.get(escrowId);
    if (!record || record.status !== 'held') {
      return err(`Escrow ${escrowId} is not in a verifiable (held) state`);
    }

    record.variantExecuted = variantName;

    // ─── CANARY VARIANT INTEGRATION POINT ──────────────────────────────────
    if (variantName === 'v2-optimized') {
      console.log(`[Canary] Running v2-optimized evaluation logic for escrow ${escrowId}`);
      // Implement alternative trust score weighting / optimized calculations here
      // e.g., if (lowTrustScoreWeightCondition) { ... }
    }

    record.status = 'verified';
    return ok(record);
  }

  /** Compensation for `verify`: revert verification. Idempotent. */
  async unverify(escrowId: string): Promise<StepOutcome<EscrowRecord>> {
    const record = this.store.get(escrowId);
    if (record && record.status === 'verified') {
      record.status = 'held';
    }
    return ok(record ?? { escrowId, amount: 0, status: 'none' });
  }

  /** Forward: release funds to the beneficiary. */
  async release(escrowId: string, variantName = 'baseline'): Promise<StepOutcome<EscrowRecord>> {
    const record = this.store.get(escrowId);
    if (!record || record.status !== 'verified') {
      return err(`Escrow ${escrowId} must be verified before release`);
    }

    if (variantName === 'v2-optimized') {
      console.log(`[Canary] Running v2-optimized gas/settlement release for escrow ${escrowId}`);
      // Implement alternative escrow release logic or optimizations here
    }

    record.status = 'released';
    return ok(record);
  }

  /** Compensation for `release`: reverse the release. Idempotent. */
  async reverseRelease(escrowId: string): Promise<StepOutcome<EscrowRecord>> {
    const record = this.store.get(escrowId);
    if (record && record.status === 'released') {
      record.status = 'reversed';
    }
    return ok(record ?? { escrowId, amount: 0, status: 'none' });
  }
}

export interface SettlementParams {
  escrowId: string;
  amount: number;
  variantName?: string; // Optional variant configuration field
}

/**
 * Builds the canonical hold → verify → release settlement saga.
 * Modified to forward the experimental canary execution context down into step action engines.
 */
export function buildSettlementSaga(
  engine: EscrowEngine,
  params: SettlementParams,
): SagaDefinition {
  const { escrowId, amount, variantName = 'baseline' } = params;
  return {
    name: 'escrow-settlement',
    steps: [
      {
        id: 'hold',
        action: (_ctx: SagaContext) => engine.hold(escrowId, amount),
        compensate: (_ctx: SagaContext) => engine.releaseHold(escrowId),
      },
      {
        id: 'verify',
        action: (_ctx: SagaContext) => engine.verify(escrowId, variantName),
        compensate: (_ctx: SagaContext) => engine.unverify(escrowId),
      },
      {
        id: 'release',
        action: (_ctx: SagaContext) => engine.release(escrowId, variantName),
        compensate: (_ctx: SagaContext) => engine.reverseRelease(escrowId),
      },
    ],
  };
}
