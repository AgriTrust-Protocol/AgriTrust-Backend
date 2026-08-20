import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  OfflineBuffer,
  InMemoryStore,
} from '../../src/attestation/offline-buffer';
import { DedupFilter } from '../../src/attestation/dedup-filter';
import { ConnectivityMonitor } from '../../src/network/connectivity-monitor';
import {
  SyncEngine,
  SyncTransport,
} from '../../src/attestation/sync-engine';
import {
  AttestationRecord,
  SyncResultItem,
  PayloadTooLargeError,
  BufferFullError,
  MAX_PAYLOAD_BYTES,
} from '../../src/types/attestation';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRecord(
  id: string,
  overrides?: Partial<AttestationRecord>,
): AttestationRecord {
  return {
    id,
    payload: { sensor: 'temp', value: 22.5 },
    compressedSize: 128,
    status: 'pending',
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    retryCount: 0,
    ...overrides,
  };
}

function makeTransport(
  handler?: (batch: AttestationRecord[]) => SyncResultItem[],
): SyncTransport {
  return async (batch) =>
    handler
      ? handler(batch)
      : batch.map((r) => ({
          id: r.id,
          accepted: true,
          acceptedAt: new Date().toISOString(),
        }));
}

// ── OfflineBuffer tests ────────────────────────────────────────────────────

describe('OfflineBuffer — enqueue / dequeue / ack / nack', () => {
  let store: InMemoryStore;
  let buffer: OfflineBuffer;

  beforeEach(() => {
    store = new InMemoryStore();
    buffer = new OfflineBuffer(store);
  });

  it('enqueues a record into the pending partition', async () => {
    await buffer.enqueue(makeRecord('a1'));
    const pending = await buffer.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('a1');
    expect(pending[0].status).toBe('pending');
  });

  it('rejects payloads exceeding 256 KB', async () => {
    const oversized = makeRecord('big', {
      compressedSize: MAX_PAYLOAD_BYTES + 1,
    });
    await expect(buffer.enqueue(oversized)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it('dequeueBatch moves records from pending to syncing', async () => {
    await buffer.enqueue(makeRecord('a1'));
    await buffer.enqueue(makeRecord('a2'));
    await buffer.enqueue(makeRecord('a3'));

    const batch = await buffer.dequeueBatch(2);
    expect(batch).toHaveLength(2);

    const pending = await buffer.getPending();
    expect(pending).toHaveLength(1);
  });

  it('ack transitions a record to acknowledged', async () => {
    await buffer.enqueue(makeRecord('a1'));
    await buffer.dequeueBatch(1);
    await buffer.ack('a1');

    const pending = await buffer.getPending();
    expect(pending).toHaveLength(0);

    const total = await buffer.size();
    expect(total).toBe(1); // still in store as acknowledged
  });

  it('nack transitions a record to failed with a reason', async () => {
    await buffer.enqueue(makeRecord('a1'));
    await buffer.dequeueBatch(1);
    await buffer.nack('a1', '500: internal server error');

    const failed = await buffer.getFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0].nackReason).toBe('500: internal server error');
    expect(failed[0].retryCount).toBe(1);
  });

  it('resetSyncing moves all syncing records back to pending', async () => {
    await buffer.enqueue(makeRecord('a1'));
    await buffer.enqueue(makeRecord('a2'));
    await buffer.dequeueBatch(2);

    const count = await buffer.resetSyncing();
    expect(count).toBe(2);

    const pending = await buffer.getPending();
    expect(pending).toHaveLength(2);
  });

  it('getConflicts filters for 409-rejected records', async () => {
    await buffer.enqueue(makeRecord('a1'));
    await buffer.enqueue(makeRecord('a2'));
    await buffer.dequeueBatch(2);
    await buffer.nack('a1', '409: conflict');
    await buffer.nack('a2', '500: server error');

    const conflicts = await buffer.getConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe('a1');
  });
});

describe('OfflineBuffer — LRU eviction', () => {
  it('evicts acknowledged records when record count limit is reached', async () => {
    const store = new InMemoryStore();
    const buffer = new OfflineBuffer(store, { maxRecords: 5, maxBytes: 10_000_000 });

    // Fill with 5 records and ack them all
    for (let i = 0; i < 5; i++) {
      await buffer.enqueue(makeRecord(`old-${i}`));
    }
    const batch = await buffer.dequeueBatch(5);
    for (const r of batch) {
      await buffer.ack(r.id);
    }

    // Enqueue one more — should evict an acknowledged record
    await buffer.enqueue(makeRecord('new'));
    const total = await buffer.size();
    expect(total).toBe(5); // one was evicted
  });

  it('evicts failed records after acknowledged are exhausted', async () => {
    const store = new InMemoryStore();
    const buffer = new OfflineBuffer(store, { maxRecords: 3, maxBytes: 10_000_000 });

    // Fill and nack all
    for (let i = 0; i < 3; i++) {
      await buffer.enqueue(makeRecord(`fail-${i}`));
    }
    const batch = await buffer.dequeueBatch(3);
    for (const r of batch) {
      await buffer.nack(r.id, 'error');
    }

    // Enqueue a new record — should evict a failed record
    await buffer.enqueue(makeRecord('new'));
    const total = await buffer.size();
    expect(total).toBe(3);
  });

  it('throws BufferFullError when only pending/syncing records remain', async () => {
    const store = new InMemoryStore();
    const buffer = new OfflineBuffer(store, { maxRecords: 2, maxBytes: 10_000_000 });

    await buffer.enqueue(makeRecord('a1'));
    await buffer.enqueue(makeRecord('a2'));

    await expect(buffer.enqueue(makeRecord('a3'))).rejects.toBeInstanceOf(
      BufferFullError,
    );
  });

  it('evicts by byte limit', async () => {
    const store = new InMemoryStore();
    const buffer = new OfflineBuffer(store, { maxRecords: 100, maxBytes: 300 });

    // Each record is 128 bytes compressed, 2 fit within 300
    await buffer.enqueue(makeRecord('a1'));
    await buffer.enqueue(makeRecord('a2'));
    // Ack them to make them evictable
    const batch = await buffer.dequeueBatch(2);
    for (const r of batch) await buffer.ack(r.id);

    // This third 128-byte record pushes past 300 bytes — eviction should kick in
    await buffer.enqueue(makeRecord('a3'));
    const total = await buffer.size();
    expect(total).toBeLessThanOrEqual(3);
  });
});

// ── DedupFilter tests ──────────────────────────────────────────────────────

describe('DedupFilter — Bloom filter', () => {
  it('remembers added IDs', () => {
    const filter = new DedupFilter();
    filter.add('id-1');
    filter.add('id-2');

    expect(filter.mightContain('id-1')).toBe(true);
    expect(filter.mightContain('id-2')).toBe(true);
  });

  it('reports false for IDs never added (low FP rate)', () => {
    const filter = new DedupFilter();
    for (let i = 0; i < 1000; i++) {
      filter.add(`known-${i}`);
    }

    let falsePositives = 0;
    const trials = 10_000;
    for (let i = 0; i < trials; i++) {
      if (filter.mightContain(`unknown-${i}`)) falsePositives++;
    }

    // With 1 MB and ~10 hashes, 1000 items should yield FP rate ≈ 0.
    expect(falsePositives / trials).toBeLessThan(0.001);
  });

  it('rebase clears and re-seeds the filter', () => {
    const filter = new DedupFilter();
    filter.add('old-1');
    filter.add('old-2');

    filter.rebase(['new-1']);

    expect(filter.mightContain('new-1')).toBe(true);
    // old-1 may or may not be a false positive, but the filter was cleared
    expect(filter.count()).toBe(1);
  });

  it('serialise / deserialise round-trips', () => {
    const filter = new DedupFilter();
    filter.add('round-trip');

    const data = filter.serialise();
    const restored = DedupFilter.deserialise(data, filter.count());

    expect(restored.mightContain('round-trip')).toBe(true);
    expect(restored.count()).toBe(1);
  });

  it('estimated FP rate is below 0.1% for 10,000 items', () => {
    const filter = new DedupFilter();
    for (let i = 0; i < 10_000; i++) {
      filter.add(`item-${i}`);
    }
    expect(filter.estimatedFalsePositiveRate()).toBeLessThan(0.001);
  });
});

// ── ConnectivityMonitor tests ──────────────────────────────────────────────

describe('ConnectivityMonitor', () => {
  it('starts online by default', () => {
    const mon = new ConnectivityMonitor();
    expect(mon.online).toBe(true);
    mon.destroy();
  });

  it('emits online/offline events on state transitions', async () => {
    const mon = new ConnectivityMonitor({ initialOnline: false });
    const events: string[] = [];

    mon.on('online', () => events.push('online'));
    mon.on('offline', () => events.push('offline'));

    mon.setOnline();
    mon.setOnline(); // duplicate — should NOT re-emit
    mon.setOffline();
    mon.setOffline(); // duplicate — should NOT re-emit
    mon.setOnline();

    expect(events).toEqual(['online', 'offline', 'online']);
    mon.destroy();
  });

  it('can start offline', () => {
    const mon = new ConnectivityMonitor({ initialOnline: false });
    expect(mon.online).toBe(false);
    mon.destroy();
  });
});

// ── SyncEngine integration tests ───────────────────────────────────────────

describe('SyncEngine — flush loop', () => {
  let store: InMemoryStore;
  let buffer: OfflineBuffer;
  let filter: DedupFilter;
  let monitor: ConnectivityMonitor;

  beforeEach(() => {
    store = new InMemoryStore();
    buffer = new OfflineBuffer(store);
    filter = new DedupFilter();
    monitor = new ConnectivityMonitor({ initialOnline: false });
  });

  afterEach(() => monitor.destroy());

  it('flushes all pending records when connectivity is restored', async () => {
    // Enqueue while offline
    for (let i = 0; i < 5; i++) {
      await buffer.enqueue(makeRecord(`rec-${i}`));
    }

    const transport = makeTransport();
    const engine = new SyncEngine({
      buffer,
      filter,
      monitor,
      transport,
      batchSize: 100,
    });

    engine.start();
    monitor.setOnline();

    const result = await engine.waitForFlush();
    expect(result).not.toBeNull();
    expect(result!.totalAcked).toBe(5);
    expect(result!.totalNacked).toBe(0);

    const pending = await buffer.getPending();
    expect(pending).toHaveLength(0);

    engine.stop();
  });

  it('handles 409 conflicts via onConflict callback', async () => {
    await buffer.enqueue(makeRecord('ok-1'));
    await buffer.enqueue(makeRecord('conflict-1'));

    const conflicts: string[] = [];
    const transport = makeTransport((batch) =>
      batch.map((r) =>
        r.id === 'conflict-1'
          ? { id: r.id, accepted: false, statusCode: 409, reason: 'stale' }
          : { id: r.id, accepted: true, acceptedAt: new Date().toISOString() },
      ),
    );

    const engine = new SyncEngine({
      buffer,
      filter,
      monitor,
      transport,
      onConflict: (rec) => conflicts.push(rec.id),
      batchSize: 100,
    });

    engine.start();
    monitor.setOnline();

    const result = await engine.waitForFlush();
    expect(result!.totalAcked).toBe(1);
    expect(result!.totalConflicts).toBe(1);
    expect(conflicts).toEqual(['conflict-1']);

    const conflictRecords = await buffer.getConflicts();
    expect(conflictRecords).toHaveLength(1);

    engine.stop();
  });

  it('nacks all records on transport failure and stops flushing', async () => {
    for (let i = 0; i < 3; i++) {
      await buffer.enqueue(makeRecord(`rec-${i}`));
    }

    const transport: SyncTransport = async () => {
      throw new Error('Network error');
    };

    const engine = new SyncEngine({
      buffer,
      filter,
      monitor,
      transport,
      batchSize: 100,
    });

    engine.start();
    monitor.setOnline();

    const result = await engine.waitForFlush();
    expect(result!.totalNacked).toBe(3);

    const failed = await buffer.getFailed();
    expect(failed).toHaveLength(3);

    engine.stop();
  });

  it('deduplicates records already in the Bloom filter', async () => {
    // Pre-seed filter with a known ID
    filter.add('already-synced');

    await buffer.enqueue(makeRecord('already-synced'));
    await buffer.enqueue(makeRecord('new-one'));

    const transportCalls: string[][] = [];
    const transport: SyncTransport = async (batch) => {
      transportCalls.push(batch.map((r) => r.id));
      return batch.map((r) => ({
        id: r.id,
        accepted: true,
        acceptedAt: new Date().toISOString(),
      }));
    };

    const engine = new SyncEngine({
      buffer,
      filter,
      monitor,
      transport,
      batchSize: 100,
    });

    engine.start();
    monitor.setOnline();

    await engine.waitForFlush();

    // Only 'new-one' should have been sent to the server
    expect(transportCalls).toHaveLength(1);
    expect(transportCalls[0]).toEqual(['new-one']);

    engine.stop();
  });

  it('flushes in batches respecting the batch size', async () => {
    for (let i = 0; i < 250; i++) {
      await buffer.enqueue(makeRecord(`rec-${String(i).padStart(4, '0')}`));
    }

    const batchSizes: number[] = [];
    const transport: SyncTransport = async (batch) => {
      batchSizes.push(batch.length);
      return batch.map((r) => ({
        id: r.id,
        accepted: true,
        acceptedAt: new Date().toISOString(),
      }));
    };

    const engine = new SyncEngine({
      buffer,
      filter,
      monitor,
      transport,
      batchSize: 100,
    });

    engine.start();
    monitor.setOnline();

    await engine.waitForFlush();

    // 250 records → 3 batches: 100 + 100 + 50
    expect(batchSizes).toEqual([100, 100, 50]);

    const pending = await buffer.getPending();
    expect(pending).toHaveLength(0);

    engine.stop();
  });

  it('resets syncing records to pending on offline event', async () => {
    for (let i = 0; i < 3; i++) {
      await buffer.enqueue(makeRecord(`rec-${i}`));
    }

    // Dequeue manually to simulate mid-flush state
    await buffer.dequeueBatch(3);

    // Start the engine so it registers the offline handler
    const transport = makeTransport();
    const engine = new SyncEngine({
      buffer,
      filter,
      monitor,
      transport,
      batchSize: 100,
    });
    engine.start();

    // Fire offline — the engine's handler calls buffer.resetSyncing()
    monitor.setOnline();
    monitor.setOffline();

    // Give the async handler time to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    const pending = await buffer.getPending();
    expect(pending).toHaveLength(3);

    engine.stop();
  });
});

describe('SyncEngine — network partition simulation', () => {
  it('survives offline → online → offline → online cycle', async () => {
    const store = new InMemoryStore();
    const buffer = new OfflineBuffer(store);
    const filter = new DedupFilter();
    const monitor = new ConnectivityMonitor({ initialOnline: false });

    // Phase 1: enqueue while offline
    for (let i = 0; i < 10; i++) {
      await buffer.enqueue(makeRecord(`phase1-${i}`));
    }

    let callCount = 0;
    const transport: SyncTransport = async (batch) => {
      callCount++;
      if (callCount === 1) {
        // First call: simulate partial success then network drop
        return batch.slice(0, 5).map((r) => ({
          id: r.id,
          accepted: true,
          acceptedAt: new Date().toISOString(),
        }));
      }
      // Subsequent calls: all success
      return batch.map((r) => ({
        id: r.id,
        accepted: true,
        acceptedAt: new Date().toISOString(),
      }));
    };

    const engine = new SyncEngine({
      buffer,
      filter,
      monitor,
      transport,
      batchSize: 10,
    });

    engine.start();

    // Cycle 1: come online
    monitor.setOnline();
    await engine.waitForFlush();

    // Phase 2: go offline, enqueue more
    monitor.setOffline();
    for (let i = 0; i < 5; i++) {
      await buffer.enqueue(makeRecord(`phase2-${i}`));
    }

    // Cycle 2: come online again
    monitor.setOnline();
    await engine.waitForFlush();

    // All records should be processed
    const pending = await buffer.getPending();
    expect(pending).toHaveLength(0);

    engine.stop();
    monitor.destroy();
  });

  it('handles mixed ack/nack/conflict responses in a single batch', async () => {
    const store = new InMemoryStore();
    const buffer = new OfflineBuffer(store);
    const filter = new DedupFilter();
    const monitor = new ConnectivityMonitor({ initialOnline: false });

    await buffer.enqueue(makeRecord('ack-me'));
    await buffer.enqueue(makeRecord('nack-me'));
    await buffer.enqueue(makeRecord('conflict-me'));

    const conflicts: string[] = [];
    const transport: SyncTransport = async (batch) =>
      batch.map((r) => {
        if (r.id === 'ack-me') {
          return { id: r.id, accepted: true, acceptedAt: new Date().toISOString() };
        }
        if (r.id === 'conflict-me') {
          return { id: r.id, accepted: false, statusCode: 409, reason: 'stale timestamp' };
        }
        return { id: r.id, accepted: false, statusCode: 500, reason: 'internal error' };
      });

    const engine = new SyncEngine({
      buffer,
      filter,
      monitor,
      transport,
      onConflict: (rec) => conflicts.push(rec.id),
      batchSize: 100,
    });

    engine.start();
    monitor.setOnline();

    const result = await engine.waitForFlush();
    expect(result!.totalAcked).toBe(1);
    expect(result!.totalNacked).toBe(1);
    expect(result!.totalConflicts).toBe(1);
    expect(conflicts).toEqual(['conflict-me']);

    engine.stop();
    monitor.destroy();
  });
});

describe('SyncEngine — Bloom filter rebase', () => {
  it('rebases the Bloom filter after a complete flush', async () => {
    const store = new InMemoryStore();
    const buffer = new OfflineBuffer(store);
    const filter = new DedupFilter();
    const monitor = new ConnectivityMonitor({ initialOnline: false });

    // Pre-seed filter with stale entries
    filter.add('stale-1');
    filter.add('stale-2');
    expect(filter.count()).toBe(2);

    await buffer.enqueue(makeRecord('fresh-1'));

    const transport = makeTransport();
    const engine = new SyncEngine({
      buffer,
      filter,
      monitor,
      transport,
      batchSize: 100,
    });

    engine.start();
    monitor.setOnline();
    await engine.waitForFlush();

    // After full flush with no remaining pending, filter was rebased
    expect(filter.count()).toBe(0);

    engine.stop();
    monitor.destroy();
  });
});

