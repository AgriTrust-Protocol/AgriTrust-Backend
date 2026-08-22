/**
 * SyncEngine — reconnection flush orchestration.
 *
 * Listens to {@link ConnectivityMonitor} 'online' events and initiates a
 * flush loop that drains the offline buffer in batches of 100, POSTing to
 * `/attestations/sync`.  Each response item is ack'd or nack'd individually.
 *
 * Conflict records (409) are routed to a conflict-resolution callback.
 * After a full flush the Bloom dedup filter is rebased.
 *
 * Invariant: all buffered attestations must be flushed within 60 s of
 * connectivity restoration (FLUSH_WINDOW_MS).
 */

import { ConnectivityMonitor } from '../network/connectivity-monitor';
import { OfflineBuffer } from './offline-buffer';
import { DedupFilter } from './dedup-filter';
import {
  AttestationRecord,
  SyncResultItem,
  ConflictCallback,
  FLUSH_BATCH_SIZE,
  FLUSH_WINDOW_MS,
} from '../types/attestation';

/** Function that POSTs a batch to the server and returns per-item results. */
export type SyncTransport = (batch: AttestationRecord[]) => Promise<SyncResultItem[]>;

export interface SyncEngineOptions {
  buffer: OfflineBuffer;
  filter: DedupFilter;
  monitor: ConnectivityMonitor;
  transport: SyncTransport;
  onConflict?: ConflictCallback;
  /** Override for testing — max ms allowed per flush cycle. */
  flushWindowMs?: number;
  /** Override batch size for testing. */
  batchSize?: number;
}

export type SyncEngineState = 'idle' | 'flushing' | 'stopped';

export class SyncEngine {
  private readonly buffer: OfflineBuffer;
  private readonly filter: DedupFilter;
  private readonly monitor: ConnectivityMonitor;
  private readonly transport: SyncTransport;
  private readonly onConflict: ConflictCallback | undefined;
  private readonly flushWindowMs: number;
  private readonly batchSize: number;

  private _state: SyncEngineState = 'idle';
  private flushPromise: Promise<FlushResult> | null = null;

  constructor(opts: SyncEngineOptions) {
    this.buffer = opts.buffer;
    this.filter = opts.filter;
    this.monitor = opts.monitor;
    this.transport = opts.transport;
    this.onConflict = opts.onConflict;
    this.flushWindowMs = opts.flushWindowMs ?? FLUSH_WINDOW_MS;
    this.batchSize = opts.batchSize ?? FLUSH_BATCH_SIZE;
  }

  get state(): SyncEngineState {
    return this._state;
  }

  /** Start listening for connectivity events. */
  start(): void {
    this._state = 'idle';
    this.monitor.on('online', this.handleOnline);
    this.monitor.on('offline', this.handleOffline);

    // If already online, kick off a flush immediately.
    if (this.monitor.online) {
      this.handleOnline();
    }
  }

  /** Stop listening and abort any in-progress flush. */
  stop(): void {
    this._state = 'stopped';
    this.monitor.off('online', this.handleOnline);
    this.monitor.off('offline', this.handleOffline);
  }

  /** Wait for the current flush cycle to complete (useful in tests). */
  async waitForFlush(): Promise<FlushResult | null> {
    return this.flushPromise;
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private handleOnline = (): void => {
    if (this._state === 'flushing' || this._state === 'stopped') return;
    this._state = 'flushing';
    this.flushPromise = this.runFlushLoop();
    this.flushPromise.then(() => {
      if (this._state !== 'stopped') this._state = 'idle';
    });
  };

  private handleOffline = (): void => {
    // Reset any in-flight syncing records back to pending.
    void this.buffer.resetSyncing();
  };

  // ── Flush loop ─────────────────────────────────────────────────────────

  private async runFlushLoop(): Promise<FlushResult> {
    const deadline = Date.now() + this.flushWindowMs;
    let totalAcked = 0;
    let totalNacked = 0;
    let totalConflicts = 0;

    while (this._state === 'flushing' && Date.now() < deadline) {
      const batch = await this.buffer.dequeueBatch(this.batchSize);
      if (batch.length === 0) break;

      // Filter out duplicates already known to the Bloom filter.
      const fresh = batch.filter((r) => !this.filter.mightContain(r.id));
      // Ack duplicates immediately — they were already delivered.
      for (const dup of batch.filter((r) => this.filter.mightContain(r.id))) {
        await this.buffer.ack(dup.id);
        totalAcked++;
      }

      if (fresh.length === 0) continue;

      let results: SyncResultItem[];
      try {
        results = await this.transport(fresh);
      } catch {
        // Transport failure — return records to pending for retry.
        for (const rec of fresh) {
          await this.buffer.nack(rec.id, 'transport_error');
        }
        totalNacked += fresh.length;
        break; // stop flushing until next online event
      }

      for (const result of results) {
        if (result.accepted) {
          await this.buffer.ack(result.id);
          this.filter.add(result.id);
          totalAcked++;
        } else if (result.statusCode === 409) {
          await this.buffer.nack(result.id, `409: ${result.reason ?? 'conflict'}`);
          totalConflicts++;
          if (this.onConflict) {
            const rec = await this.findRecord(result.id, fresh);
            if (rec) this.onConflict(rec);
          }
        } else {
          await this.buffer.nack(
            result.id,
            `${result.statusCode ?? 'unknown'}: ${result.reason ?? 'rejected'}`,
          );
          totalNacked++;
        }
      }
    }

    // Rebase the Bloom filter after a full flush.
    const pending = await this.buffer.getPending();
    if (pending.length === 0) {
      // All flushed — rebase with acknowledged IDs only.
      this.filter.rebase([]);
    }

    return { totalAcked, totalNacked, totalConflicts };
  }

  private async findRecord(
    id: string,
    batch: AttestationRecord[],
  ): Promise<AttestationRecord | undefined> {
    return batch.find((r) => r.id === id);
  }
}

export interface FlushResult {
  totalAcked: number;
  totalNacked: number;
  totalConflicts: number;
}
