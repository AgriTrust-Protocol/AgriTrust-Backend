import { Pool } from 'pg';
import { TransactionCoordinator } from '../core/state/transaction_controller';
import { SorobanSubmitter, SorobanSubmitResult } from '../blockchain/soroban_bridge';
import { acquireSiloBinLock, releaseSiloBinLock } from './silo_lock';

export interface TwoPhaseDepositParams {
  siloId: number;
  binId: number;
  weightKg: number;
  ticketId: string;
  /** Pre-signed Soroban transaction envelope XDR for the on-chain record. */
  signedTxXdr: string;
}

export interface TwoPhaseDepositResult {
  ticketId: string;
  txUuid: string;
  previousBalance: number;
  newBalance: number;
  sorobanHash: string | null;
  committed: boolean;
}

/**
 * Inventory deposit wrapped in the two-phase commit protocol.
 *
 * 1. Prepare — deduct inventory tentatively, write pending_transactions row.
 * 2. Submit the Soroban transaction and await confirmation.
 * 3. Commit on success, or rollback (restore balance) on failure.
 */
export async function processTwoPhaseDeposit(
  pool: Pool,
  coordinator: TransactionCoordinator,
  submitter: SorobanSubmitter,
  params: TwoPhaseDepositParams,
): Promise<TwoPhaseDepositResult> {
  const cargoId = `silo-${params.siloId}-bin-${params.binId}`;

  const acquired = await acquireSiloBinLock(params.siloId, params.binId);
  if (!acquired) {
    throw new Error(
      `Lock acquisition timed out for silo=${params.siloId} bin=${params.binId} ticket=${params.ticketId}`,
    );
  }

  let txUuid: string;
  let previousBalance: number;
  let newBalance: number;

  try {
    const { rows: balanceRows } = await pool.query(
      `SELECT balance FROM silo_bins WHERE silo_id = $1 AND bin_id = $2 FOR UPDATE`,
      [params.siloId, params.binId],
    );

    previousBalance = balanceRows.length > 0 ? parseFloat(balanceRows[0].balance) : 0;
    newBalance = previousBalance + params.weightKg;

    // Phase 1: prepare
    txUuid = await coordinator.prepare({
      cargoId,
      operationType: 'inventory_deposit',
      beforeState: { siloId: params.siloId, binId: params.binId, balance: previousBalance },
      afterState: { siloId: params.siloId, binId: params.binId, balance: newBalance },
    });

    // Apply tentative state
    if (balanceRows.length === 0) {
      await pool.query(`INSERT INTO silo_bins (silo_id, bin_id, balance) VALUES ($1, $2, $3)`, [
        params.siloId,
        params.binId,
        newBalance,
      ]);
    } else {
      await pool.query(
        `UPDATE silo_bins SET balance = $3, updated_at = NOW() WHERE silo_id = $1 AND bin_id = $2`,
        [params.siloId, params.binId, newBalance],
      );
    }
  } finally {
    await releaseSiloBinLock(params.siloId, params.binId);
  }

  // Phase 2: submit to Soroban and confirm
  let result: SorobanSubmitResult;
  try {
    result = await submitter.submitAndConfirm(params.signedTxXdr);
  } catch {
    // Submission failed entirely — rollback
    await rollbackBalance(pool, params.siloId, params.binId, previousBalance);
    await coordinator.rollback(txUuid);
    return {
      ticketId: params.ticketId,
      txUuid,
      previousBalance,
      newBalance: previousBalance,
      sorobanHash: null,
      committed: false,
    };
  }

  if (result.status === 'confirmed') {
    await coordinator.commit(txUuid, result.confirmedLedgerHash ?? result.hash);
    return {
      ticketId: params.ticketId,
      txUuid,
      previousBalance,
      newBalance,
      sorobanHash: result.hash,
      committed: true,
    };
  }

  // Failed or timed-out — rollback
  await rollbackBalance(pool, params.siloId, params.binId, previousBalance);
  await coordinator.rollback(txUuid);
  return {
    ticketId: params.ticketId,
    txUuid,
    previousBalance,
    newBalance: previousBalance,
    sorobanHash: result.hash,
    committed: false,
  };
}

async function rollbackBalance(
  pool: Pool,
  siloId: number,
  binId: number,
  previousBalance: number,
): Promise<void> {
  await pool.query(
    `UPDATE silo_bins SET balance = $3, updated_at = NOW() WHERE silo_id = $1 AND bin_id = $2`,
    [siloId, binId, previousBalance],
  );
}
