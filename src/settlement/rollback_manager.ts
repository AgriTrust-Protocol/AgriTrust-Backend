/**
 * Rollback Manager — atomic rollback of failed settlement groups.
 *
 * Technical invariant: if one leg of a netted settlement fails, ALL legs in
 * that netting group must be rolled back. This module coordinates the rollback
 * across both SWIFT and blockchain rails.
 */

import { NettingGroup } from './netting_engine';
import { SwiftSettlementResult } from './swift_adapter';
import { BatchTransferResult } from './blockchain_adapter';

export type RailType = 'swift' | 'blockchain';

export interface SettlementLeg {
  rail: RailType;
  /** Reference ID on the rail (UETR for SWIFT, txHash for blockchain). */
  railRef: string;
  /** Internal instruction or netting-group ID. */
  instructionId: string;
  /** Settlement IDs contained in this leg. */
  settlementIds: string[];
}

export interface RollbackRecord {
  groupId: string;
  reason: string;
  rolledBackLegs: SettlementLeg[];
  failedRollbacks: Array<{ leg: SettlementLeg; reason: string }>;
  completedAt: Date;
  fullyRolledBack: boolean;
}

export interface SwiftReversal {
  /** Issues a return / recall for a previously accepted pacs.008 message. */
  reverse(uetr: string, reason: string): Promise<{ success: boolean; error?: string }>;
}

export interface BlockchainReversal {
  /**
   * Attempts to reverse an ERC-20 transfer. On Polygon this requires the
   * recipient to sign a return transfer; the implementation handles the
   * coordination (e.g. via escrow or relayer). Returns success only if the
   * on-chain reversal is confirmed.
   */
  reverse(txHash: string, reason: string): Promise<{ success: boolean; error?: string }>;
}

export interface RollbackConfig {
  /** Maximum reversal attempts per leg (default: 3). */
  maxRetries?: number;
  /** Backoff between attempts in milliseconds (default: 2000). */
  backoffMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * RollbackManager enforces the all-or-nothing atomicity invariant for netting
 * groups. When any leg of a group fails post-submission, it issues reversals
 * for all previously accepted legs on both rails.
 */
export class RollbackManager {
  private readonly maxRetries: number;
  private readonly backoffMs: number;

  constructor(
    private readonly swiftReversal: SwiftReversal,
    private readonly blockchainReversal: BlockchainReversal,
    config: RollbackConfig = {},
  ) {
    this.maxRetries = config.maxRetries ?? 3;
    this.backoffMs = config.backoffMs ?? 2000;
  }

  /**
   * Evaluates whether a settlement group needs rollback (any leg failed),
   * then issues reversals for all accepted legs.
   *
   * @param group            The netting group being settled.
   * @param swiftResults     Per-instruction results from the SWIFT adapter.
   * @param blockchainResult Batch result from the blockchain adapter.
   */
  async handleSettlementResult(
    group: NettingGroup,
    swiftResults: SwiftSettlementResult[],
    blockchainResult: BatchTransferResult,
  ): Promise<RollbackRecord | null> {
    const hasSwiftFailure = swiftResults.some((r) => !r.accepted);
    const hasBlockchainFailure =
      !blockchainResult.accepted || blockchainResult.failedTransfers.length > 0;

    if (!hasSwiftFailure && !hasBlockchainFailure) {
      // All legs settled successfully — no rollback needed
      return null;
    }

    const failureReason = this.buildFailureReason(swiftResults, blockchainResult);

    // Collect all accepted legs that must be reversed
    const legsToReverse: SettlementLeg[] = [];

    for (const r of swiftResults) {
      if (r.accepted && r.uetr) {
        legsToReverse.push({
          rail: 'swift',
          railRef: r.uetr,
          instructionId: r.instructionId,
          settlementIds: this.settlementIdsForInstruction(group, r.instructionId),
        });
      }
    }

    if (blockchainResult.accepted && blockchainResult.txHash) {
      legsToReverse.push({
        rail: 'blockchain',
        railRef: blockchainResult.txHash,
        instructionId: blockchainResult.nettingGroupId,
        settlementIds: group.allSettlementIds,
      });
    }

    return this.rollback(group.groupId, legsToReverse, failureReason);
  }

  /**
   * Executes rollback for a list of legs with retry and backoff.
   * All legs are attempted regardless of individual failures to maximise
   * the number of successful reversals (best-effort per leg, atomic intent).
   */
  async rollback(groupId: string, legs: SettlementLeg[], reason: string): Promise<RollbackRecord> {
    const rolledBack: SettlementLeg[] = [];
    const failedRollbacks: Array<{ leg: SettlementLeg; reason: string }> = [];

    for (const leg of legs) {
      const result = await this.reverseLegWithRetry(leg, reason);
      if (result.success) {
        rolledBack.push(leg);
      } else {
        failedRollbacks.push({ leg, reason: result.error ?? 'unknown' });
        this.criticalAlert(groupId, leg, result.error ?? 'unknown');
      }
    }

    const record: RollbackRecord = {
      groupId,
      reason,
      rolledBackLegs: rolledBack,
      failedRollbacks,
      completedAt: new Date(),
      fullyRolledBack: failedRollbacks.length === 0,
    };

    return record;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async reverseLegWithRetry(
    leg: SettlementLeg,
    reason: string,
  ): Promise<{ success: boolean; error?: string }> {
    let lastError = 'unknown';

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result =
          leg.rail === 'swift'
            ? await this.swiftReversal.reverse(leg.railRef, reason)
            : await this.blockchainReversal.reverse(leg.railRef, reason);

        if (result.success) return { success: true };
        lastError = result.error ?? 'reversal returned not successful';
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }

      if (attempt < this.maxRetries) {
        await sleep(this.backoffMs);
      }
    }

    return { success: false, error: lastError };
  }

  private settlementIdsForInstruction(group: NettingGroup, instructionId: string): string[] {
    for (const pos of group.positions) {
      if (pos.settlementIds.includes(instructionId)) {
        return pos.settlementIds;
      }
    }
    return group.allSettlementIds;
  }

  private buildFailureReason(
    swiftResults: SwiftSettlementResult[],
    blockchainResult: BatchTransferResult,
  ): string {
    const parts: string[] = [];

    const failedSwift = swiftResults.filter((r) => !r.accepted);
    if (failedSwift.length > 0) {
      parts.push(
        `SWIFT failures: ${failedSwift
          .map((r) => `${r.instructionId}(${r.rejectionReason ?? 'unknown'})`)
          .join(', ')}`,
      );
    }

    if (!blockchainResult.accepted || blockchainResult.failedTransfers.length > 0) {
      parts.push(
        `Blockchain failures: ${blockchainResult.failedTransfers.length} transfers failed`,
      );
    }

    return parts.join('; ');
  }

  private criticalAlert(groupId: string, leg: SettlementLeg, error: string): void {
    console.error(
      `[CRITICAL] Rollback failed for netting group. ` +
        `group_id=${groupId} rail=${leg.rail} ref=${leg.railRef} error=${error}. ` +
        `Manual intervention required.`,
    );
  }
}
