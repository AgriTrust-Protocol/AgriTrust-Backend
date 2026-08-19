/**
 * Blockchain Adapter — USDC ERC-20 transfers on Polygon
 *
 * Batches ERC-20 USDC transfer calls for blockchain-based cross-border
 * settlements. Uses a multicall pattern to submit multiple transfers in a
 * single transaction, reducing gas costs and confirming atomically.
 *
 * Settlement rail: ERC-20 USDC on Polygon (PoS mainnet).
 */

import { NetPosition, NettingGroup } from './netting_engine';

/** USDC contract address on Polygon mainnet. */
export const POLYGON_USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** Polygon chain ID. */
export const POLYGON_CHAIN_ID = 137;

export interface BlockchainWallet {
  /** Ethereum address (checksummed). */
  address: string;
}

export interface WalletDirectory {
  /** Resolves an internal party ID to their on-chain wallet. */
  lookup(partyId: string): Promise<BlockchainWallet | null>;
}

export interface Erc20Transfer {
  from: string;
  to: string;
  /** Amount in USDC base units (6 decimals). */
  amountUnits: bigint;
  /** Human-readable amount for logging. */
  amountUsdc: number;
  /** Original settlement IDs for traceability. */
  settlementIds: string[];
}

export interface BatchTransferRequest {
  transfers: Erc20Transfer[];
  /** Netting group ID for atomic rollback correlation. */
  nettingGroupId: string;
}

export interface TransactionReceipt {
  txHash: string;
  blockNumber: number;
  success: boolean;
  gasUsed?: number;
}

export interface BatchTransferResult {
  nettingGroupId: string;
  txHash: string;
  accepted: boolean;
  receipts: TransactionReceipt[];
  failedTransfers: Array<{ transfer: Erc20Transfer; reason: string }>;
}

export interface PolygonRpcClient {
  /**
   * Submits a batch of ERC-20 transfer calls. Implementations should use
   * a multicall contract or sequenced transactions with atomicity guarantees.
   */
  submitBatch(
    contractAddress: string,
    transfers: Erc20Transfer[],
  ): Promise<TransactionReceipt[]>;
}

/** USDC uses 6 decimal places. */
const USDC_DECIMALS = 6;

function toUsdcUnits(amount: number): bigint {
  // Round to 6 decimal places before converting to integer units
  const rounded = Math.round(amount * 10 ** USDC_DECIMALS);
  return BigInt(rounded);
}

/**
 * BlockchainAdapter batches USDC transfers for a netting group and submits
 * them to the Polygon network via the provided RPC client.
 *
 * Settlements denominated in non-USD currencies are converted to USDC
 * using the provided USD-equivalent amounts from the netting engine.
 */
export class BlockchainAdapter {
  constructor(
    private readonly wallets: WalletDirectory,
    private readonly rpc: PolygonRpcClient,
  ) {}

  /**
   * Builds and submits a batch of USDC transfers for all blockchain-eligible
   * positions in the netting group. Positions involving the CCP node are
   * included; SWIFT-only counterparties without wallets are skipped.
   */
  async settleGroup(group: NettingGroup): Promise<BatchTransferResult> {
    const transfers = await this.buildTransfers(group.positions);

    if (transfers.eligible.length === 0) {
      return {
        nettingGroupId: group.groupId,
        txHash: '',
        accepted: false,
        receipts: [],
        failedTransfers: transfers.failed,
      };
    }

    const request: BatchTransferRequest = {
      transfers: transfers.eligible,
      nettingGroupId: group.groupId,
    };

    const receipts = await this.rpc.submitBatch(
      POLYGON_USDC_ADDRESS,
      request.transfers,
    );

    const anyFailed = receipts.some((r) => !r.success);
    const txHash = receipts[0]?.txHash ?? '';

    return {
      nettingGroupId: group.groupId,
      txHash,
      accepted: !anyFailed && receipts.length > 0,
      receipts,
      failedTransfers: [
        ...transfers.failed,
        ...receipts
          .filter((r) => !r.success)
          .map((r, i) => ({
            transfer: transfers.eligible[i],
            reason: `Transaction reverted: ${r.txHash}`,
          })),
      ],
    };
  }

  /**
   * Constructs ERC-20 transfer objects from net positions.
   * Positions with missing wallet records are collected in `failed`.
   */
  async buildTransfers(positions: NetPosition[]): Promise<{
    eligible: Erc20Transfer[];
    failed: Array<{ transfer: Erc20Transfer; reason: string }>;
  }> {
    const eligible: Erc20Transfer[] = [];
    const failed: Array<{ transfer: Erc20Transfer; reason: string }> = [];

    for (const pos of positions) {
      const fromWallet = await this.wallets.lookup(pos.debtorId);
      const toWallet = await this.wallets.lookup(pos.creditorId);

      // Build a partial transfer for error reporting
      const partial: Erc20Transfer = {
        from: fromWallet?.address ?? pos.debtorId,
        to: toWallet?.address ?? pos.creditorId,
        amountUnits: toUsdcUnits(pos.netAmountUsd),
        amountUsdc: pos.netAmountUsd,
        settlementIds: pos.settlementIds,
      };

      if (!fromWallet) {
        failed.push({ transfer: partial, reason: `No wallet for debtor: ${pos.debtorId}` });
        continue;
      }

      if (!toWallet) {
        failed.push({ transfer: partial, reason: `No wallet for creditor: ${pos.creditorId}` });
        continue;
      }

      eligible.push({
        from: fromWallet.address,
        to: toWallet.address,
        amountUnits: toUsdcUnits(pos.netAmountUsd),
        amountUsdc: pos.netAmountUsd,
        settlementIds: pos.settlementIds,
      });
    }

    return { eligible, failed };
  }
}
