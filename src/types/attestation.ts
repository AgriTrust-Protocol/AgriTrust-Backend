/**
 * Attestation types — offline buffer, sync status, and conflict resolution.
 *
 * These types back the IndexedDB-based offline attestation buffer used by
 * mobile field agents operating in intermittent-connectivity zones.
 */

/** Sync lifecycle states matching the IndexedDB object store partitions. */
export type SyncStatus = 'pending' | 'syncing' | 'failed' | 'acknowledged';

/** A single attestation record stored in the local buffer. */
export interface AttestationRecord {
  /** Client-generated UUID — used for deduplication across reconnection cycles. */
  id: string;
  /** The attestation payload (opaque to the buffer layer). */
  payload: Record<string, unknown>;
  /** Compressed payload size in bytes (zstd level 3, max 256 KB). */
  compressedSize: number;
  /** Current partition the record lives in. */
  status: SyncStatus;
  /** ISO-8601 timestamp of local creation. */
  createdAt: string;
  /** ISO-8601 timestamp of last status transition. */
  lastModified: string;
  /** Number of sync attempts made for this record. */
  retryCount: number;
  /** If nack'd, the reason string from the server or transport layer. */
  nackReason?: string;
}

/** Shape of the server response for a single attestation in a sync batch. */
export interface SyncResultItem {
  id: string;
  /** true when the server accepted the attestation. */
  accepted: boolean;
  /** Present on rejection — the HTTP status code (e.g. 409 for conflict). */
  statusCode?: number;
  /** Server-side acceptance timestamp (ISO-8601). */
  acceptedAt?: string;
  /** Human-readable rejection reason. */
  reason?: string;
}

/** Callback signature surfaced when a record enters the conflict queue. */
export type ConflictCallback = (record: AttestationRecord) => void;

// ── Invariants / bounds ────────────────────────────────────────────────────

/** Maximum records before LRU eviction kicks in. */
export const MAX_BUFFER_RECORDS = 10_000;
/** Maximum buffer size in bytes before LRU eviction kicks in. */
export const MAX_BUFFER_BYTES = 500 * 1024 * 1024; // 500 MB
/** Maximum compressed attestation payload size. */
export const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB
/** Batch size for each flush cycle POST. */
export const FLUSH_BATCH_SIZE = 100;
/** Maximum time (ms) to flush all buffered attestations after reconnection. */
export const FLUSH_WINDOW_MS = 60_000;
/** Bloom filter size in bytes (1 MB). */
export const BLOOM_FILTER_BYTES = 1 * 1024 * 1024; // 1 MB
/** Target false-positive rate for the Bloom filter. */
export const BLOOM_FALSE_POSITIVE_RATE = 0.001;

// ── Errors ─────────────────────────────────────────────────────────────────

export class PayloadTooLargeError extends Error {
  readonly code = 'ATTESTATION_PAYLOAD_TOO_LARGE';
  constructor(
    readonly id: string,
    readonly sizeBytes: number,
  ) {
    super(
      `Attestation "${id}" compressed payload is ${sizeBytes} bytes, ` +
        `exceeding the ${MAX_PAYLOAD_BYTES} byte limit`,
    );
    this.name = 'PayloadTooLargeError';
  }
}

export class BufferFullError extends Error {
  readonly code = 'ATTESTATION_BUFFER_FULL';
  constructor(
    readonly currentCount: number,
    readonly currentBytes: number,
  ) {
    super(
      `Buffer is full: ${currentCount} records / ${currentBytes} bytes. ` +
        `LRU eviction was unable to free space.`,
    );
    this.name = 'BufferFullError';
  }
}

export class ConflictError extends Error {
  readonly code = 'ATTESTATION_CONFLICT';
  constructor(readonly id: string) {
    super(`Server rejected attestation "${id}" with 409 Conflict`);
    this.name = 'ConflictError';
  }
}
