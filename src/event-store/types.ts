/**
 * Event Sourcing — core type definitions.
 *
 * An aggregate's state is the left-fold of its ordered event stream. Events are
 * immutable and append-only; snapshots are an optimisation that lets rehydration
 * skip replaying the entire history.
 */

export type EventData = Record<string, unknown>;
export type EventMetadata = Record<string, unknown>;

/** An event as supplied by a caller, before it is assigned positions. */
export interface NewEvent<T extends EventData = EventData> {
  eventType: string;
  data: T;
  metadata?: EventMetadata;
}

/** A persisted event, carrying its global and per-stream ordering. */
export interface StreamEvent<T extends EventData = EventData> {
  /** Global 64-bit ordering across all streams (BIGSERIAL, exposed as string). */
  globalSeq: string;
  streamId: string;
  /** Per-stream 32-bit position; the first event in a stream is version 1. */
  streamVersion: number;
  eventType: string;
  data: T;
  metadata: EventMetadata;
  createdAt: string;
}

/** A compressed, point-in-time fold of a stream up to `version`. */
export interface Snapshot<S = unknown> {
  streamId: string;
  version: number;
  state: S;
  createdAt: string;
}

/** Pure reducer folding an event into aggregate state. */
export type Reducer<S> = (state: S, event: StreamEvent) => S;

export interface RehydrateResult<S> {
  state: S;
  /** The stream version the returned state reflects. */
  version: number;
  /** Whether a snapshot was used as the starting point. */
  fromSnapshot: boolean;
}

// ── Invariants / bounds (from the feature spec) ────────────────────────────

/** Maximum uncompressed event payload: 64 KB. */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
/** Take a snapshot every N events per aggregate. */
export const SNAPSHOT_THRESHOLD = 100;
/** Rehydration reads at most this many events beyond the latest snapshot. */
export const MAX_REHYDRATE_EVENTS = 10_000;
/** Events older than this are eligible for cold-storage archival. */
export const ARCHIVE_AFTER_DAYS = 365;

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Raised when an append's `expectedVersion` does not match the stream's
 * current version. The HTTP layer maps this to 409 Conflict.
 */
export class ConcurrencyConflictError extends Error {
  readonly code = 'CONCURRENCY_CONFLICT';
  constructor(
    readonly streamId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Concurrency conflict on stream ${streamId}: expected version ` +
        `${expectedVersion} but stream is at ${actualVersion}`,
    );
    this.name = 'ConcurrencyConflictError';
  }
}

/** Raised when an event's uncompressed payload exceeds the 64 KB limit. */
export class PayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE';
  constructor(
    readonly eventType: string,
    readonly sizeBytes: number,
  ) {
    super(
      `Event "${eventType}" payload is ${sizeBytes} bytes, exceeding the ` +
        `${MAX_EVENT_PAYLOAD_BYTES} byte limit`,
    );
    this.name = 'PayloadTooLargeError';
  }
}
