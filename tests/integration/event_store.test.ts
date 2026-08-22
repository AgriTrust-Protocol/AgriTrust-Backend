import { describe, it, expect, beforeEach } from 'vitest';
import {
  EventPersistence,
  ArchivableEvent,
  SnapshotRow,
  payloadSize,
} from '../../src/event-store/persistence';
import { Snapshotter } from '../../src/event-store/snapshotter';
import { EventStore } from '../../src/event-store/stream';
import { ColdStorageArchiver, ObjectStore } from '../../src/event-store/cold-storage';
import {
  ConcurrencyConflictError,
  MAX_EVENT_PAYLOAD_BYTES,
  NewEvent,
  PayloadTooLargeError,
  Reducer,
  StreamEvent,
} from '../../src/event-store/types';

/**
 * In-memory EventPersistence used to exercise the event store without a live
 * PostgreSQL instance. Mirrors the optimistic-concurrency and ordering
 * semantics of the pg implementation.
 */
class FakePersistence implements EventPersistence {
  private events: StreamEvent[] = [];
  private snapshots: SnapshotRow[] = [];
  private globalSeq = 0;

  async getCurrentVersion(streamId: string): Promise<number> {
    const forStream = this.events.filter((e) => e.streamId === streamId);
    return forStream.length === 0 ? 0 : Math.max(...forStream.map((e) => e.streamVersion));
  }

  async appendEvents(
    streamId: string,
    events: NewEvent[],
    expectedVersion: number,
  ): Promise<StreamEvent[]> {
    for (const e of events) {
      const size = payloadSize(e.data);
      if (size > MAX_EVENT_PAYLOAD_BYTES) {
        throw new PayloadTooLargeError(e.eventType, size);
      }
    }
    const current = await this.getCurrentVersion(streamId);
    if (current !== expectedVersion) {
      throw new ConcurrencyConflictError(streamId, expectedVersion, current);
    }
    const appended = events.map((e, i) => ({
      globalSeq: String(++this.globalSeq),
      streamId,
      streamVersion: expectedVersion + i + 1,
      eventType: e.eventType,
      data: e.data,
      metadata: e.metadata ?? {},
      createdAt: new Date(2025, 0, 1).toISOString(),
    }));
    this.events.push(...appended);
    return appended;
  }

  async readStreamEvents(
    streamId: string,
    afterVersion: number,
    limit: number,
  ): Promise<StreamEvent[]> {
    return this.events
      .filter((e) => e.streamId === streamId && e.streamVersion > afterVersion)
      .sort((a, b) => a.streamVersion - b.streamVersion)
      .slice(0, limit);
  }

  async saveSnapshot(streamId: string, version: number, snapshot: Buffer): Promise<void> {
    this.snapshots = this.snapshots.filter(
      (s) => !(s.streamId === streamId && s.version === version),
    );
    this.snapshots.push({
      streamId,
      version,
      snapshot,
      createdAt: new Date().toISOString(),
    });
  }

  async getLatestSnapshot(streamId: string): Promise<SnapshotRow | null> {
    const forStream = this.snapshots
      .filter((s) => s.streamId === streamId)
      .sort((a, b) => b.version - a.version);
    return forStream[0] ?? null;
  }
}

// ── A simple counter aggregate used across tests ───────────────────────────
interface CounterState {
  total: number;
  applied: number;
}
const counterReducer: Reducer<CounterState> = (state, event) => {
  const amount = (event.data.amount as number) ?? 0;
  return { total: state.total + amount, applied: state.applied + 1 };
};
const initialCounter = (): CounterState => ({ total: 0, applied: 0 });

// Deterministic PRNG (mulberry32) so the property test is reproducible.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STREAM = '11111111-1111-1111-1111-111111111111';

describe('EventStore — append & optimistic concurrency', () => {
  let persistence: FakePersistence;
  let store: EventStore<CounterState>;

  beforeEach(() => {
    persistence = new FakePersistence();
    store = new EventStore(persistence, counterReducer, initialCounter);
  });

  it('appends events and advances the stream version', async () => {
    const stream = store.stream(STREAM);
    const res = await stream.append([{ eventType: 'Incremented', data: { amount: 5 } }], 0);
    expect(res.version).toBe(1);
    expect(res.events[0].streamVersion).toBe(1);
    expect(await stream.currentVersion()).toBe(1);
  });

  it('rejects a stale expectedVersion with a ConcurrencyConflictError (→ 409)', async () => {
    const stream = store.stream(STREAM);
    await stream.append([{ eventType: 'Incremented', data: { amount: 1 } }], 0);

    await expect(
      stream.append([{ eventType: 'Incremented', data: { amount: 1 } }], 0),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);
  });

  it('rejects payloads larger than 64 KB', async () => {
    const stream = store.stream(STREAM);
    const big = 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 1);
    await expect(
      stream.append([{ eventType: 'Big', data: { blob: big } }], 0),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
});

describe('Snapshotter — cadence, rehydration & performance', () => {
  let persistence: FakePersistence;
  let store: EventStore<CounterState>;

  beforeEach(() => {
    persistence = new FakePersistence();
    store = new EventStore(persistence, counterReducer, initialCounter);
  });

  it('creates a snapshot every 100 events', async () => {
    const stream = store.stream(STREAM);
    let version = 0;
    for (let i = 0; i < 100; i++) {
      const res = await stream.append([{ eventType: 'Incremented', data: { amount: 1 } }], version);
      version = res.version;
    }
    // The 100th append should have produced a snapshot at version 100.
    const snap = await persistence.getLatestSnapshot(STREAM);
    expect(snap?.version).toBe(100);
  });

  it('rehydrates to the same state as a full fold (snapshot + tail)', async () => {
    const stream = store.stream(STREAM);
    let version = 0;
    for (let i = 0; i < 150; i++) {
      const res = await stream.append([{ eventType: 'Incremented', data: { amount: 2 } }], version);
      version = res.version;
    }

    const rehydrated = await stream.rehydrate();
    expect(rehydrated.fromSnapshot).toBe(true);
    expect(rehydrated.version).toBe(150);
    expect(rehydrated.state.total).toBe(300);
    expect(rehydrated.state.applied).toBe(150);
  });

  it('rehydrates a 10,000-event aggregate in under 50ms', async () => {
    const stream = store.stream(STREAM);
    // Seed 10k events directly to keep setup fast, then snapshot.
    let version = 0;
    const BATCH = 500;
    while (version < 10_000) {
      const batch: NewEvent[] = Array.from({ length: BATCH }, () => ({
        eventType: 'Incremented',
        data: { amount: 1 },
      }));
      const res = await stream.append(batch, version);
      version = res.version;
    }
    // Ensure a snapshot exists at the head so rehydration is snapshot + 0 tail.
    await new Snapshotter(persistence, {
      reducer: counterReducer,
      initialState: initialCounter,
    }).createSnapshot(STREAM);

    const start = Date.now();
    const result = await stream.rehydrate();
    const elapsed = Date.now() - start;

    expect(result.state.total).toBe(10_000);
    expect(elapsed).toBeLessThan(50);
  });
});

describe('Snapshotter — property: fold(rehydrate(events)) == fold(events)', () => {
  it('holds for random event sequences', async () => {
    // Run several randomized trials with distinct shapes/seeds.
    for (let trial = 0; trial < 25; trial++) {
      const persistence = new FakePersistence();
      const store = new EventStore(persistence, counterReducer, initialCounter);
      const snapshotter = new Snapshotter(persistence, {
        reducer: counterReducer,
        initialState: initialCounter,
      });
      const streamId = `00000000-0000-0000-0000-${String(trial).padStart(12, '0')}`;
      const stream = store.stream(streamId);

      const rand = prng(1000 + trial);
      const count = Math.floor(rand() * 350) + 1; // 1..350 events

      // Append in random-sized batches, tracking the expected fold directly.
      const expected = initialCounter();
      let version = 0;
      let i = 0;
      while (i < count) {
        const batchLen = Math.min(count - i, Math.floor(rand() * 7) + 1);
        const batch: NewEvent[] = [];
        for (let b = 0; b < batchLen; b++) {
          const amount = Math.floor(rand() * 200) - 100; // -100..99
          batch.push({ eventType: 'Delta', data: { amount } });
          expected.total += amount;
          expected.applied += 1;
        }
        const res = await stream.append(batch, version);
        version = res.version;
        i += batchLen;
      }

      // Reference fold over the raw events read straight from storage.
      const allEvents = await persistence.readStreamEvents(streamId, 0, 100_000);
      const foldDirect = snapshotter.fold(initialCounter(), allEvents);

      // Rehydration must reproduce the same state via snapshot + tail.
      const rehydrated = await stream.rehydrate();

      expect(rehydrated.state).toEqual(foldDirect);
      expect(rehydrated.state).toEqual(expected);
      expect(rehydrated.version).toBe(count);
    }
  });
});

describe('ColdStorageArchiver', () => {
  class FakeArchiveStore implements ObjectStore {
    objects = new Map<string, Buffer>();
    async putObject(key: string, body: Buffer): Promise<void> {
      this.objects.set(key, body);
    }
    async getObject(key: string): Promise<Buffer> {
      const v = this.objects.get(key);
      if (!v) throw new Error(`No such object: ${key}`);
      return v;
    }
  }

  it('archives events older than 365 days into year/month prefixes and retains a pointer', async () => {
    const marked: Array<{ seqs: string[]; key: string }> = [];
    const oldEvents: ArchivableEvent[] = [
      {
        globalSeq: '1',
        streamId: STREAM,
        streamVersion: 1,
        eventType: 'Old',
        data: { a: 1 },
        metadata: {},
        createdAt: '2023-03-15T00:00:00.000Z',
        createdAtDate: new Date('2023-03-15T00:00:00.000Z'),
      },
      {
        globalSeq: '2',
        streamId: STREAM,
        streamVersion: 2,
        eventType: 'Old',
        data: { a: 2 },
        metadata: {},
        createdAt: '2023-04-20T00:00:00.000Z',
        createdAtDate: new Date('2023-04-20T00:00:00.000Z'),
      },
    ];

    const fakePersistence = {
      async readEventsOlderThan() {
        return oldEvents;
      },
      async markArchived(seqs: string[], key: string) {
        marked.push({ seqs, key });
      },
    };

    const objectStore = new FakeArchiveStore();
    const archiver = new ColdStorageArchiver(fakePersistence, objectStore, {
      now: () => new Date('2025-06-24T00:00:00.000Z'),
    });

    const summary = await archiver.archiveOnce();

    expect(summary.archivedCount).toBe(2);
    // Two distinct months → two objects under the correct prefixes.
    expect(summary.objects).toHaveLength(2);
    expect(
      [...objectStore.objects.keys()].some((k) => k.startsWith('events/year=2023/month=03/')),
    ).toBe(true);
    expect(
      [...objectStore.objects.keys()].some((k) => k.startsWith('events/year=2023/month=04/')),
    ).toBe(true);
    // Each archived group was marked with its cold-storage key (pointer).
    expect(marked).toHaveLength(2);
    expect(marked.every((m) => m.key.startsWith('events/year=2023/'))).toBe(true);
  });

  it('is a no-op when there are no expired events', async () => {
    const archiver = new ColdStorageArchiver(
      {
        async readEventsOlderThan() {
          return [];
        },
        async markArchived() {
          /* unused */
        },
      },
      new FakeArchiveStore(),
    );
    const summary = await archiver.archiveOnce();
    expect(summary.archivedCount).toBe(0);
    expect(summary.objects).toHaveLength(0);
  });
});
