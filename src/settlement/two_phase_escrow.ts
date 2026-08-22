import { TransactionCoordinator } from '../core/state/transaction_controller';
import { SorobanSubmitter, SorobanSubmitResult } from '../blockchain/soroban_bridge';
import { EscrowEngine, EscrowStatus } from './escrow-engine';

export interface TwoPhaseEscrowReleaseParams {
  escrowId: string;
  amount: number;
  /** Pre-signed Soroban transaction envelope XDR for the on-chain escrow release. */
  signedTxXdr: string;
}

export interface TwoPhaseEscrowResult {
  escrowId: string;
  txUuid: string;
  previousStatus: EscrowStatus;
  finalStatus: EscrowStatus;
  sorobanHash: string | null;
  committed: boolean;
}

/**
 * Escrow release wrapped in the two-phase commit protocol.
 *
 * 1. Prepare — mark escrow as released tentatively, write pending_transactions row.
 * 2. Submit the Soroban transaction and await confirmation.
 * 3. Commit on success, or rollback (restore previous escrow state) on failure.
 */
export async function processTwoPhaseEscrowRelease(
  coordinator: TransactionCoordinator,
  submitter: SorobanSubmitter,
  engine: EscrowEngine,
  params: TwoPhaseEscrowReleaseParams,
): Promise<TwoPhaseEscrowResult> {
  const current = engine.getState(params.escrowId);
  const previousStatus: EscrowStatus = current?.status ?? 'none';

  if (previousStatus !== 'verified') {
    throw new Error(
      `Escrow ${params.escrowId} must be verified before two-phase release (current: ${previousStatus})`,
    );
  }

  // Phase 1: prepare
  const txUuid = await coordinator.prepare({
    cargoId: params.escrowId,
    operationType: 'escrow_release',
    beforeState: { escrowId: params.escrowId, status: previousStatus, amount: params.amount },
    afterState: { escrowId: params.escrowId, status: 'released', amount: params.amount },
  });

  // Apply tentative release
  const releaseOutcome = await engine.release(params.escrowId);
  if (!releaseOutcome.ok) {
    await coordinator.rollback(txUuid);
    throw new Error(`Escrow release failed locally: ${releaseOutcome.reason}`);
  }

  // Phase 2: submit to Soroban and confirm
  let result: SorobanSubmitResult;
  try {
    result = await submitter.submitAndConfirm(params.signedTxXdr);
  } catch {
    await engine.reverseRelease(params.escrowId);
    await coordinator.rollback(txUuid);
    return {
      escrowId: params.escrowId,
      txUuid,
      previousStatus,
      finalStatus: 'reversed',
      sorobanHash: null,
      committed: false,
    };
  }

  if (result.status === 'confirmed') {
    await coordinator.commit(txUuid, result.confirmedLedgerHash ?? result.hash);
    return {
      escrowId: params.escrowId,
      txUuid,
      previousStatus,
      finalStatus: 'released',
      sorobanHash: result.hash,
      committed: true,
    };
  }

  // Failed or timed-out — rollback
  await engine.reverseRelease(params.escrowId);
  await coordinator.rollback(txUuid);
  return {
    escrowId: params.escrowId,
    txUuid,
    previousStatus,
    finalStatus: 'reversed',
    sorobanHash: result.hash,
    committed: false,
  };
}
