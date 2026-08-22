import { PendingStore, PendingTransactionRow } from './pending_store';
import { SorobanSubmitter, SorobanTxStatus } from '../../blockchain/soroban_bridge';

export interface RecoveryWorkerConfig {
  /** How often the worker scans for timed-out transactions (ms). */
  intervalMs: number;
  /** Callback invoked to restore the database to before_state on rollback. */
  onRollback: (row: PendingTransactionRow) => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 10_000;

/**
 * Background recovery worker that scans the pending_transactions table for
 * timed-out entries and resolves them:
 *
 *  - If the row has a soroban_hash, the worker queries the Soroban ledger.
 *    A SUCCESS status triggers a commit; FAILED or NOT_FOUND triggers a
 *    rollback.
 *  - If no soroban_hash was ever recorded, the transaction was never submitted
 *    on-chain and the row is rolled back immediately.
 */
export class RecoveryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly store: PendingStore,
    private readonly submitter: SorobanSubmitter | null,
    private readonly config: RecoveryWorkerConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for testing: run one recovery sweep synchronously. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let recovered = 0;

    try {
      const timedOut = await this.store.findTimedOut();

      for (const row of timedOut) {
        try {
          const resolved = await this.resolve(row);
          if (resolved) recovered++;
        } catch {
          // Individual failures are swallowed; the row stays pending and
          // will be retried on the next tick.
        }
      }
    } finally {
      this.running = false;
    }

    return recovered;
  }

  private async resolve(row: PendingTransactionRow): Promise<boolean> {
    if (row.soroban_hash && this.submitter) {
      const status: SorobanTxStatus = await this.submitter.getTransactionStatus(row.soroban_hash);

      if (status.status === 'SUCCESS') {
        const ledgerHash = status.ledgerHash ?? row.soroban_hash;
        await this.store.markCommitted(row.tx_uuid, ledgerHash);
        return true;
      }

      if (status.status === 'PENDING') {
        // Still in-flight — leave it for the next tick.
        return false;
      }
    }

    // No hash, FAILED, or NOT_FOUND → rollback.
    await this.store.markRolledBack(row.tx_uuid);
    await this.config.onRollback(row);
    return true;
  }
}
