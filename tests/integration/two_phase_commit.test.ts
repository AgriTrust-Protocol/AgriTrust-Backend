import { describe, it, expect, beforeEach } from 'vitest';
import { TransactionCoordinator } from '../../src/core/state/transaction_controller';
import { PendingStore, PendingTransactionRow } from '../../src/core/state/pending_store';
import { RecoveryWorker } from '../../src/core/state/recovery_worker';
import {
  SorobanSubmitter,
  SorobanSubmitResult,
  SorobanTxStatus,
} from '../../src/blockchain/soroban_bridge';
import { EscrowEngine } from '../../src/settlement/escrow-engine';
import { processTwoPhaseEscrowRelease } from '../../src/settlement/two_phase_escrow';

/**
 * In-memory fake of PendingStore.  Mirrors the real store's semantics
 * (sequential-per-cargo guard, status transitions) without PostgreSQL.
 */
class FakePendingStore {
  rows = new Map<string, PendingTransactionRow>();

  async insert(row: {
    txUuid: string;
    cargoId: string;
    operationType: string;
    beforeState: Record<string, unknown>;
    afterState: Record<string, unknown>;
    timeoutAt: Date;
  }): Promise<void> {
    for (const existing of this.rows.values()) {
      if (existing.cargo_id === row.cargoId && existing.status === 'pending') {
        throw new Error(
          `Overlapping pending transaction for cargo_id=${row.cargoId} (existing tx_uuid=${existing.tx_uuid})`,
        );
      }
    }

    this.rows.set(row.txUuid, {
      tx_uuid: row.txUuid,
      cargo_id: row.cargoId,
      operation_type: row.operationType,
      before_state: row.beforeState,
      after_state: row.afterState,
      soroban_hash: null,
      status: 'pending',
      created_at: new Date().toISOString(),
      timeout_at: row.timeoutAt.toISOString(),
    });
  }

  async markCommitted(txUuid: string, sorobanHash: string): Promise<void> {
    const row = this.rows.get(txUuid);
    if (!row || row.status !== 'pending') {
      throw new Error(`Cannot commit tx_uuid=${txUuid}: not found or not in pending status`);
    }
    row.status = 'committed';
    row.soroban_hash = sorobanHash;
  }

  async markRolledBack(txUuid: string): Promise<void> {
    const row = this.rows.get(txUuid);
    if (row && row.status === 'pending') {
      row.status = 'rolled_back';
    }
  }

  async setSorobanHash(txUuid: string, sorobanHash: string): Promise<void> {
    const row = this.rows.get(txUuid);
    if (row) {
      row.soroban_hash = sorobanHash;
    }
  }

  async getByUuid(txUuid: string): Promise<PendingTransactionRow | null> {
    return this.rows.get(txUuid) ?? null;
  }

  async findTimedOut(now: Date = new Date()): Promise<PendingTransactionRow[]> {
    const result: PendingTransactionRow[] = [];
    for (const row of this.rows.values()) {
      if (row.status === 'pending' && new Date(row.timeout_at) < now) {
        result.push(row);
      }
    }
    return result;
  }
}

/**
 * Fake SorobanSubmitter that lets tests control submission outcomes.
 */
class FakeSorobanSubmitter {
  submitResult: SorobanSubmitResult = {
    hash: 'fake-hash-abc',
    status: 'confirmed',
    confirmedLedgerHash: 'ledger-hash-123',
  };

  txStatusResult: SorobanTxStatus = { status: 'SUCCESS', ledgerHash: 'ledger-hash-123' };

  async submitTransaction(_signedXdr: string): Promise<SorobanSubmitResult> {
    return this.submitResult;
  }

  async getTransactionStatus(_txHash: string): Promise<SorobanTxStatus> {
    return this.txStatusResult;
  }

  async submitAndConfirm(
    _signedXdr: string,
    _timeoutMs?: number,
    _pollIntervalMs?: number,
  ): Promise<SorobanSubmitResult> {
    return this.submitResult;
  }
}

// ---------------------------------------------------------------------------
// TransactionCoordinator
// ---------------------------------------------------------------------------

describe('TransactionCoordinator', () => {
  let store: FakePendingStore;
  let coordinator: TransactionCoordinator;

  beforeEach(() => {
    store = new FakePendingStore();
    coordinator = new TransactionCoordinator(store as unknown as PendingStore);
  });

  it('prepare() inserts a pending row and returns a UUID', async () => {
    const uuid = await coordinator.prepare({
      cargoId: 'cargo-1',
      operationType: 'inventory_deposit',
      beforeState: { balance: 100 },
      afterState: { balance: 80 },
    });

    expect(uuid).toBeTruthy();
    const row = await store.getByUuid(uuid);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.cargo_id).toBe('cargo-1');
    expect(row!.before_state).toEqual({ balance: 100 });
    expect(row!.after_state).toEqual({ balance: 80 });
  });

  it('commit() transitions the row to committed with soroban_hash', async () => {
    const uuid = await coordinator.prepare({
      cargoId: 'cargo-2',
      operationType: 'escrow_release',
      beforeState: {},
      afterState: {},
    });

    await coordinator.commit(uuid, 'soroban-hash-xyz');

    const row = await store.getByUuid(uuid);
    expect(row!.status).toBe('committed');
    expect(row!.soroban_hash).toBe('soroban-hash-xyz');
  });

  it('rollback() transitions the row to rolled_back', async () => {
    const uuid = await coordinator.prepare({
      cargoId: 'cargo-3',
      operationType: 'inventory_deposit',
      beforeState: { balance: 50 },
      afterState: { balance: 30 },
    });

    await coordinator.rollback(uuid);

    const row = await store.getByUuid(uuid);
    expect(row!.status).toBe('rolled_back');
  });

  it('rejects overlapping pending transactions for the same cargo_id', async () => {
    await coordinator.prepare({
      cargoId: 'cargo-4',
      operationType: 'inventory_deposit',
      beforeState: {},
      afterState: {},
    });

    await expect(
      coordinator.prepare({
        cargoId: 'cargo-4',
        operationType: 'inventory_deposit',
        beforeState: {},
        afterState: {},
      }),
    ).rejects.toThrow(/Overlapping pending transaction/);
  });

  it('allows a new pending tx after the previous one is committed', async () => {
    const uuid1 = await coordinator.prepare({
      cargoId: 'cargo-5',
      operationType: 'inventory_deposit',
      beforeState: {},
      afterState: {},
    });

    await coordinator.commit(uuid1, 'hash-1');

    const uuid2 = await coordinator.prepare({
      cargoId: 'cargo-5',
      operationType: 'inventory_deposit',
      beforeState: {},
      afterState: {},
    });

    expect(uuid2).toBeTruthy();
    expect(uuid2).not.toBe(uuid1);
  });

  it('allows a new pending tx after the previous one is rolled back', async () => {
    const uuid1 = await coordinator.prepare({
      cargoId: 'cargo-6',
      operationType: 'inventory_deposit',
      beforeState: {},
      afterState: {},
    });

    await coordinator.rollback(uuid1);

    const uuid2 = await coordinator.prepare({
      cargoId: 'cargo-6',
      operationType: 'inventory_deposit',
      beforeState: {},
      afterState: {},
    });

    expect(uuid2).toBeTruthy();
  });

  it('commit() throws if the row is not in pending status', async () => {
    const uuid = await coordinator.prepare({
      cargoId: 'cargo-7',
      operationType: 'test',
      beforeState: {},
      afterState: {},
    });
    await coordinator.rollback(uuid);

    await expect(coordinator.commit(uuid, 'hash')).rejects.toThrow(
      /not found or not in pending status/,
    );
  });
});

// ---------------------------------------------------------------------------
// RecoveryWorker
// ---------------------------------------------------------------------------

describe('RecoveryWorker', () => {
  let store: FakePendingStore;
  let submitter: FakeSorobanSubmitter;
  const rolledBack: PendingTransactionRow[] = [];

  beforeEach(() => {
    store = new FakePendingStore();
    submitter = new FakeSorobanSubmitter();
    rolledBack.length = 0;
  });

  function makeWorker(sub: FakeSorobanSubmitter | null = submitter) {
    return new RecoveryWorker(
      store as unknown as PendingStore,
      sub as unknown as SorobanSubmitter,
      {
        intervalMs: 100,
        onRollback: async (row) => {
          rolledBack.push(row);
        },
      },
    );
  }

  it('rolls back timed-out rows with no soroban_hash', async () => {
    await store.insert({
      txUuid: 'tx-1',
      cargoId: 'cargo-1',
      operationType: 'inventory_deposit',
      beforeState: { balance: 100 },
      afterState: { balance: 80 },
      timeoutAt: new Date(Date.now() - 5000),
    });

    const worker = makeWorker(null);
    const recovered = await worker.tick();

    expect(recovered).toBe(1);
    const row = await store.getByUuid('tx-1');
    expect(row!.status).toBe('rolled_back');
    expect(rolledBack).toHaveLength(1);
    expect(rolledBack[0].tx_uuid).toBe('tx-1');
  });

  it('commits a timed-out row if Soroban reports SUCCESS', async () => {
    await store.insert({
      txUuid: 'tx-2',
      cargoId: 'cargo-2',
      operationType: 'escrow_release',
      beforeState: {},
      afterState: {},
      timeoutAt: new Date(Date.now() - 5000),
    });
    await store.setSorobanHash('tx-2', 'soroban-hash-2');

    submitter.txStatusResult = { status: 'SUCCESS', ledgerHash: 'ledger-2' };

    const worker = makeWorker();
    const recovered = await worker.tick();

    expect(recovered).toBe(1);
    const row = await store.getByUuid('tx-2');
    expect(row!.status).toBe('committed');
    expect(row!.soroban_hash).toBe('ledger-2');
    expect(rolledBack).toHaveLength(0);
  });

  it('rolls back a timed-out row if Soroban reports FAILED', async () => {
    await store.insert({
      txUuid: 'tx-3',
      cargoId: 'cargo-3',
      operationType: 'inventory_deposit',
      beforeState: { balance: 50 },
      afterState: { balance: 30 },
      timeoutAt: new Date(Date.now() - 5000),
    });
    await store.setSorobanHash('tx-3', 'soroban-hash-3');

    submitter.txStatusResult = { status: 'FAILED' };

    const worker = makeWorker();
    const recovered = await worker.tick();

    expect(recovered).toBe(1);
    const row = await store.getByUuid('tx-3');
    expect(row!.status).toBe('rolled_back');
    expect(rolledBack).toHaveLength(1);
  });

  it('leaves PENDING Soroban transactions alone (retries next tick)', async () => {
    await store.insert({
      txUuid: 'tx-4',
      cargoId: 'cargo-4',
      operationType: 'test',
      beforeState: {},
      afterState: {},
      timeoutAt: new Date(Date.now() - 5000),
    });
    await store.setSorobanHash('tx-4', 'soroban-hash-4');

    submitter.txStatusResult = { status: 'PENDING' };

    const worker = makeWorker();
    const recovered = await worker.tick();

    // Row was encountered but not resolved (still PENDING on-chain).
    expect(recovered).toBe(0);
    const row = await store.getByUuid('tx-4');
    expect(row!.status).toBe('pending');
  });

  it('ignores rows that have not timed out yet', async () => {
    await store.insert({
      txUuid: 'tx-5',
      cargoId: 'cargo-5',
      operationType: 'test',
      beforeState: {},
      afterState: {},
      timeoutAt: new Date(Date.now() + 60_000),
    });

    const worker = makeWorker();
    const recovered = await worker.tick();

    expect(recovered).toBe(0);
    const row = await store.getByUuid('tx-5');
    expect(row!.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Two-phase escrow release (simulated Soroban failure)
// ---------------------------------------------------------------------------

describe('processTwoPhaseEscrowRelease', () => {
  let store: FakePendingStore;
  let coordinator: TransactionCoordinator;
  let submitter: FakeSorobanSubmitter;
  let engine: EscrowEngine;

  beforeEach(() => {
    store = new FakePendingStore();
    coordinator = new TransactionCoordinator(store as unknown as PendingStore);
    submitter = new FakeSorobanSubmitter();
    engine = new EscrowEngine();
  });

  it('commits escrow release when Soroban confirms', async () => {
    await engine.hold('esc-1', 500);
    await engine.verify('esc-1');

    submitter.submitResult = {
      hash: 'hash-ok',
      status: 'confirmed',
      confirmedLedgerHash: 'ledger-ok',
    };

    const result = await processTwoPhaseEscrowRelease(
      coordinator,
      submitter as unknown as SorobanSubmitter,
      engine,
      { escrowId: 'esc-1', amount: 500, signedTxXdr: 'xdr-data' },
    );

    expect(result.committed).toBe(true);
    expect(result.finalStatus).toBe('released');
    expect(result.sorobanHash).toBe('hash-ok');
    expect(engine.getState('esc-1')?.status).toBe('released');

    // Pending row should be committed
    const row = store.rows.values().next().value!;
    expect(row.status).toBe('committed');
  });

  it('rolls back escrow release when Soroban fails', async () => {
    await engine.hold('esc-2', 300);
    await engine.verify('esc-2');

    submitter.submitResult = {
      hash: 'hash-fail',
      status: 'failed',
    };

    const result = await processTwoPhaseEscrowRelease(
      coordinator,
      submitter as unknown as SorobanSubmitter,
      engine,
      { escrowId: 'esc-2', amount: 300, signedTxXdr: 'xdr-data' },
    );

    expect(result.committed).toBe(false);
    expect(result.finalStatus).toBe('reversed');
    expect(engine.getState('esc-2')?.status).toBe('reversed');

    // Pending row should be rolled back
    const row = store.rows.values().next().value!;
    expect(row.status).toBe('rolled_back');
  });

  it('rolls back escrow release when Soroban submission throws', async () => {
    await engine.hold('esc-3', 200);
    await engine.verify('esc-3');

    submitter.submitAndConfirm = async () => {
      throw new Error('network unreachable');
    };

    const result = await processTwoPhaseEscrowRelease(
      coordinator,
      submitter as unknown as SorobanSubmitter,
      engine,
      { escrowId: 'esc-3', amount: 200, signedTxXdr: 'xdr-data' },
    );

    expect(result.committed).toBe(false);
    expect(result.finalStatus).toBe('reversed');
    expect(engine.getState('esc-3')?.status).toBe('reversed');
  });

  it('rejects release if escrow is not in verified state', async () => {
    await engine.hold('esc-4', 100);

    await expect(
      processTwoPhaseEscrowRelease(coordinator, submitter as unknown as SorobanSubmitter, engine, {
        escrowId: 'esc-4',
        amount: 100,
        signedTxXdr: 'xdr-data',
      }),
    ).rejects.toThrow(/must be verified/);
  });
});
