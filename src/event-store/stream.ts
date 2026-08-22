import { EventPersistence } from './persistence';
import { Snapshotter } from './snapshotter';
import { NewEvent, Reducer, RehydrateResult, StreamEvent } from './types';

export interface AppendResult {
  events: StreamEvent[];
  /** Stream version after the append. */
  version: number;
  /** Set when this append crossed a snapshot boundary and one was written. */
  snapshotVersion: number | null;
}

/**
 * A single aggregate's event stream with optimistic concurrency control.
 *
 * Callers append with the `expectedVersion` they last observed; a mismatch
 * raises `ConcurrencyConflictError` (mapped to HTTP 409). After a successful
 * append that crosses the snapshot threshold, a snapshot is created
 * opportunistically so future rehydrations stay fast.
 */
export class EventStream<S> {
  constructor(
    readonly streamId: string,
    private readonly persistence: EventPersistence,
    private readonly snapshotter: Snapshotter<S>,
  ) {}

  /** Current head version of this stream (0 if it has no events). */
  currentVersion(): Promise<number> {
    return this.persistence.getCurrentVersion(this.streamId);
  }

  /**
   * Appends events iff the stream is currently at `expectedVersion`. The append
   * itself is atomic; the post-append snapshot is best-effort and never fails
   * the write.
   */
  async append(events: NewEvent[], expectedVersion: number): Promise<AppendResult> {
    const appended = await this.persistence.appendEvents(this.streamId, events, expectedVersion);
    const version =
      appended.length > 0 ? appended[appended.length - 1].streamVersion : expectedVersion;

    let snapshotVersion: number | null = null;
    if (this.snapshotter.shouldSnapshot(version)) {
      try {
        snapshotVersion = await this.snapshotter.createSnapshot(this.streamId);
      } catch (err) {
        // Snapshotting is an optimisation — log and continue.
        console.error(
          `Snapshot creation failed for stream ${this.streamId} at version ${version}:`,
          err,
        );
      }
    }

    return { events: appended, version, snapshotVersion };
  }

  /** Rehydrates current aggregate state from snapshot + trailing events. */
  rehydrate(): Promise<RehydrateResult<S>> {
    return this.snapshotter.rehydrate(this.streamId);
  }
}

/**
 * Factory that wires persistence + a per-aggregate-type reducer into typed
 * `EventStream` instances. One `EventStore` per aggregate type.
 */
export class EventStore<S> {
  private readonly snapshotter: Snapshotter<S>;

  constructor(
    private readonly persistence: EventPersistence,
    reducer: Reducer<S>,
    initialState: () => S,
    threshold?: number,
  ) {
    this.snapshotter = new Snapshotter<S>(persistence, {
      reducer,
      initialState,
      threshold,
    });
  }

  /** Returns the stream handle for a given aggregate id. */
  stream(streamId: string): EventStream<S> {
    return new EventStream<S>(streamId, this.persistence, this.snapshotter);
  }
}
