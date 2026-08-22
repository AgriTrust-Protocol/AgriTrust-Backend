/**
 * Offline attestation buffer backed by an IndexedDB-style key-value store.
 *
 * The buffer partitions records into four object stores mirroring their sync
 * lifecycle: pending → syncing → acknowledged (happy path) or → failed.
 *
 * Storage is abstracted behind the {@link IDBStore} interface so that
 * production code can use real IndexedDB while tests inject an in-memory map.
 *
 * Capacity invariants:
 *   - 10,000 records  OR  500 MB (whichever is hit first)
 *   - LRU eviction on the *acknowledged* partition first, then *failed*
 */

import {
  AttestationRecord,
  SyncStatus,
  MAX_BUFFER_RECORDS,
  MAX_BUFFER_BYTES,
  MAX_PAYLOAD_BYTES,
  PayloadTooLargeError,
  BufferFullError,
} from '../types/attestation';

// ── Storage abstraction ────────────────────────────────────────────────────

/** Minimal IndexedDB-like key-value store contract. */
export interface IDBStore {
  get(key: string): Promise<AttestationRecord | undefined>;
  put(record: AttestationRecord): Promise<void>;
  delete(key: string): Promise<void>;
  getAll(): Promise<AttestationRecord[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

/** In-memory implementation for tests and server-side use. */
export class InMemoryStore implements IDBStore {
  private data = new Map<string, AttestationRecord>();

  async get(key: string): Promise<AttestationRecord | undefined> {
    return this.data.get(key);
  }
  async put(record: AttestationRecord): Promise<void> {
    this.data.set(record.id, record);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async getAll(): Promise<AttestationRecord[]> {
    return [...this.data.values()];
  }
  async count(): Promise<number> {
    return this.data.size;
  }
  async clear(): Promise<void> {
    this.data.clear();
  }
}

// ── Offline buffer ─────────────────────────────────────────────────────────

export interface OfflineBufferOptions {
  maxRecords?: number;
  maxBytes?: number;
}

export class OfflineBuffer {
  private readonly store: IDBStore;
  private readonly maxRecords: number;
  private readonly maxBytes: number;

  constructor(store: IDBStore, opts?: OfflineBufferOptions) {
    this.store = store;
    this.maxRecords = opts?.maxRecords ?? MAX_BUFFER_RECORDS;
    this.maxBytes = opts?.maxBytes ?? MAX_BUFFER_BYTES;
  }

  /** Insert a new attestation into the *pending* partition. */
  async enqueue(record: AttestationRecord): Promise<void> {
    if (record.compressedSize > MAX_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError(record.id, record.compressedSize);
    }

    await this.ensureCapacity(record.compressedSize);

    const now = new Date().toISOString();
    const entry: AttestationRecord = {
      ...record,
      status: 'pending',
      lastModified: now,
      retryCount: 0,
    };
    await this.store.put(entry);
  }

  /**
   * Move up to `size` *pending* records into the *syncing* partition and
   * return them for the flush loop to POST.
   */
  async dequeueBatch(size: number): Promise<AttestationRecord[]> {
    const all = await this.store.getAll();
    const pending = all
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const batch = pending.slice(0, size);
    const now = new Date().toISOString();

    for (const rec of batch) {
      const updated: AttestationRecord = {
        ...rec,
        status: 'syncing',
        lastModified: now,
      };
      await this.store.put(updated);
    }

    return batch.map((r) => ({ ...r, status: 'syncing' as const }));
  }

  /** Mark a record as *acknowledged* (server accepted it). */
  async ack(id: string): Promise<void> {
    const rec = await this.store.get(id);
    if (!rec) return;

    const updated: AttestationRecord = {
      ...rec,
      status: 'acknowledged',
      lastModified: new Date().toISOString(),
    };
    await this.store.put(updated);
  }

  /**
   * Mark a record as *failed* with a reason.
   * If the reason is a 409 conflict, the record lands in a conflict-resolution
   * queue that the SyncEngine can surface via callback.
   */
  async nack(id: string, reason: string): Promise<void> {
    const rec = await this.store.get(id);
    if (!rec) return;

    const updated: AttestationRecord = {
      ...rec,
      status: 'failed',
      lastModified: new Date().toISOString(),
      retryCount: rec.retryCount + 1,
      nackReason: reason,
    };
    await this.store.put(updated);
  }

  /** Return all records currently in the *failed* partition. */
  async getFailed(): Promise<AttestationRecord[]> {
    const all = await this.store.getAll();
    return all.filter((r) => r.status === 'failed');
  }

  /** Return all records currently in the *pending* partition. */
  async getPending(): Promise<AttestationRecord[]> {
    const all = await this.store.getAll();
    return all.filter((r) => r.status === 'pending');
  }

  /** Return conflict-rejected records (failed with 409 reason). */
  async getConflicts(): Promise<AttestationRecord[]> {
    const all = await this.store.getAll();
    return all.filter((r) => r.status === 'failed' && r.nackReason?.startsWith('409'));
  }

  /** Move *syncing* records back to *pending* (e.g. connectivity lost mid-flush). */
  async resetSyncing(): Promise<number> {
    const all = await this.store.getAll();
    const syncing = all.filter((r) => r.status === 'syncing');
    const now = new Date().toISOString();

    for (const rec of syncing) {
      const updated: AttestationRecord = {
        ...rec,
        status: 'pending',
        lastModified: now,
      };
      await this.store.put(updated);
    }
    return syncing.length;
  }

  /** Remove a specific record (e.g. after conflict resolution). */
  async remove(id: string): Promise<void> {
    await this.store.delete(id);
  }

  /** Total records across all partitions. */
  async size(): Promise<number> {
    return this.store.count();
  }

  /** Total compressed bytes across all partitions. */
  async totalBytes(): Promise<number> {
    const all = await this.store.getAll();
    return all.reduce((sum, r) => sum + r.compressedSize, 0);
  }

  /** Remove all records. */
  async clear(): Promise<void> {
    await this.store.clear();
  }

  // ── Capacity management ────────────────────────────────────────────────

  /**
   * LRU eviction: evict acknowledged records (oldest first), then failed
   * records, until the buffer has room for `incomingBytes`.
   */
  private async ensureCapacity(incomingBytes: number): Promise<void> {
    let count = await this.store.count();
    let bytes = await this.totalBytes();

    if (count < this.maxRecords && bytes + incomingBytes <= this.maxBytes) {
      return;
    }

    // Evict acknowledged first (LRU by lastModified), then failed.
    for (const partition of ['acknowledged', 'failed'] as SyncStatus[]) {
      if (count < this.maxRecords && bytes + incomingBytes <= this.maxBytes) {
        break;
      }

      const all = await this.store.getAll();
      const candidates = all
        .filter((r) => r.status === partition)
        .sort((a, b) => a.lastModified.localeCompare(b.lastModified));

      for (const rec of candidates) {
        if (count < this.maxRecords && bytes + incomingBytes <= this.maxBytes) {
          break;
        }
        await this.store.delete(rec.id);
        count--;
        bytes -= rec.compressedSize;
      }
    }

    if (count >= this.maxRecords || bytes + incomingBytes > this.maxBytes) {
      throw new BufferFullError(count, bytes);
    }
  }
}
