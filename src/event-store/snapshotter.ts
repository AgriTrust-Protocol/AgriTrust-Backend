import * as zlib from 'zlib';
import { EventPersistence } from './persistence';
import { timed } from '../api/metrics/event_store_metrics';
import {
  MAX_REHYDRATE_EVENTS,
  Reducer,
  RehydrateResult,
  SNAPSHOT_THRESHOLD,
  StreamEvent,
} from './types';

/**
 * Compression codec identifiers stored as the first byte of a snapshot blob so
 * rehydration knows how to decompress, independent of the codec in force when
 * the snapshot was written.
 */
enum CodecId {
  Snappy = 1,
  Gzip = 2,
}

/**
 * Compresses with snappy when the optional native module is installed
 * (targeting the ~10:1 ratio called for in the spec), otherwise falls back to
 * Node's built-in gzip. Either way the codec id is encoded in the blob so old
 * snapshots remain readable after a codec change.
 */
class SnapshotCodec {
  private readonly snappy: {
    compressSync: (b: Buffer) => Buffer;
    uncompressSync: (b: Buffer, opts?: unknown) => Buffer;
  } | null;

  constructor() {
    let mod: any = null;
    try {
      // Optional dependency — present in production, absent in CI is fine.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('snappy');
    } catch {
      mod = null;
    }
    this.snappy = mod && mod.compressSync && mod.uncompressSync ? mod : null;
  }

  compress(state: unknown): Buffer {
    const json = Buffer.from(JSON.stringify(state ?? null), 'utf8');
    if (this.snappy) {
      return Buffer.concat([Buffer.from([CodecId.Snappy]), this.snappy.compressSync(json)]);
    }
    return Buffer.concat([Buffer.from([CodecId.Gzip]), zlib.gzipSync(json)]);
  }

  decompress<S>(blob: Buffer): S {
    const codec = blob[0] as CodecId;
    const body = blob.subarray(1);
    let json: Buffer;
    if (codec === CodecId.Snappy) {
      if (!this.snappy) {
        throw new Error('Snapshot was snappy-compressed but the snappy module is not installed');
      }
      json = this.snappy.uncompressSync(body, { asBuffer: true }) as Buffer;
    } else if (codec === CodecId.Gzip) {
      json = zlib.gunzipSync(body);
    } else {
      throw new Error(`Unknown snapshot codec id: ${codec}`);
    }
    return JSON.parse(json.toString('utf8')) as S;
  }
}

export interface SnapshotterOptions<S> {
  /** Pure reducer folding an event into state. */
  reducer: Reducer<S>;
  /** Factory producing a fresh initial state (deep-copied per rehydration). */
  initialState: () => S;
  /** Override the snapshot cadence (default: every 100 events). */
  threshold?: number;
}

/**
 * Creates compressed aggregate snapshots and deterministically rehydrates
 * aggregate state from the latest snapshot plus the trailing events.
 */
export class Snapshotter<S> {
  private readonly codec = new SnapshotCodec();
  private readonly reducer: Reducer<S>;
  private readonly initialState: () => S;
  private readonly threshold: number;

  constructor(
    private readonly persistence: EventPersistence,
    options: SnapshotterOptions<S>,
  ) {
    this.reducer = options.reducer;
    this.initialState = options.initialState;
    this.threshold = options.threshold ?? SNAPSHOT_THRESHOLD;
  }

  /** True when `version` crosses a snapshot boundary. */
  shouldSnapshot(version: number): boolean {
    return version > 0 && version % this.threshold === 0;
  }

  /**
   * Folds the entire stream up to its current head and persists a compressed
   * snapshot. Returns the version the snapshot covers, or null if the stream
   * is empty.
   */
  async createSnapshot(streamId: string): Promise<number | null> {
    return timed('snapshot', async () => {
      const events = await this.persistence.readStreamEvents(streamId, 0, MAX_REHYDRATE_EVENTS);
      if (events.length === 0) return null;

      const state = this.fold(this.initialState(), events);
      const version = events[events.length - 1].streamVersion;
      const blob = this.codec.compress(state);
      await this.persistence.saveSnapshot(streamId, version, blob);
      return version;
    });
  }

  /**
   * Rehydrates aggregate state: load the latest snapshot (if any) as a base,
   * then fold the events with `stream_version > snapshot_version` on top of it.
   * Reads at most MAX_REHYDRATE_EVENTS trailing events.
   */
  async rehydrate(streamId: string): Promise<RehydrateResult<S>> {
    return timed('rehydrate', async () => {
      const snapshot = await this.persistence.getLatestSnapshot(streamId);

      let state: S;
      let baseVersion: number;
      let fromSnapshot: boolean;
      if (snapshot) {
        state = this.codec.decompress<S>(snapshot.snapshot);
        baseVersion = snapshot.version;
        fromSnapshot = true;
      } else {
        state = this.initialState();
        baseVersion = 0;
        fromSnapshot = false;
      }

      const events = await this.persistence.readStreamEvents(
        streamId,
        baseVersion,
        MAX_REHYDRATE_EVENTS,
      );
      state = this.fold(state, events);

      const version = events.length > 0 ? events[events.length - 1].streamVersion : baseVersion;

      return { state, version, fromSnapshot };
    });
  }

  /** Left-fold a sequence of events into state via the reducer. */
  fold(initial: S, events: StreamEvent[]): S {
    let state = initial;
    for (const event of events) {
      state = this.reducer(state, event);
    }
    return state;
  }
}
