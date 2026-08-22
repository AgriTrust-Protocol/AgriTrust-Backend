import * as zlib from 'zlib';
import { ArchivableEvent, ArchivePersistence } from './persistence';
import { timed } from '../api/metrics/event_store_metrics';
import { ARCHIVE_AFTER_DAYS } from './types';

/**
 * Minimal object-store contract the archiver needs. Implement against the AWS
 * SDK's S3 client in production; the interface keeps the archiver testable
 * without a network dependency.
 */
export interface ObjectStore {
  putObject(key: string, body: Buffer): Promise<void>;
  getObject(key: string): Promise<Buffer>;
}

export interface ArchiverOptions {
  /** Events older than this many days are archived (default: 365). */
  retentionDays?: number;
  /** Max events processed per archival pass (default: 1000). */
  batchSize?: number;
  /** Override "now" for deterministic testing. */
  now?: () => Date;
}

export interface ArchiveSummary {
  archivedCount: number;
  objects: string[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Moves events older than the retention window to cold storage (S3), grouped
 * under `events/year=YYYY/month=MM/` prefixes. After a successful upload the
 * hot-storage rows retain a pointer (`cold_storage_key`) while their bulky
 * JSONB payloads are cleared.
 */
export class ColdStorageArchiver {
  private readonly retentionDays: number;
  private readonly batchSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly persistence: ArchivePersistence,
    private readonly store: ObjectStore,
    options: ArchiverOptions = {},
  ) {
    this.retentionDays = options.retentionDays ?? ARCHIVE_AFTER_DAYS;
    this.batchSize = options.batchSize ?? 1000;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Runs one archival pass. Reads a batch of expired events, writes one S3
   * object per (year, month) partition, and marks the rows archived.
   */
  async archiveOnce(): Promise<ArchiveSummary> {
    return timed('archive', async () => {
      const cutoff = new Date(this.now().getTime() - this.retentionDays * MS_PER_DAY);
      const events = await this.persistence.readEventsOlderThan(cutoff, this.batchSize);
      if (events.length === 0) {
        return { archivedCount: 0, objects: [] };
      }

      const partitions = this.partitionByMonth(events);
      const objects: string[] = [];

      for (const [prefix, group] of partitions) {
        const key = `${prefix}${group[0].globalSeq}-${group[group.length - 1].globalSeq}.json.gz`;
        const body = zlib.gzipSync(Buffer.from(JSON.stringify(group.map(stripInternal)), 'utf8'));
        await this.store.putObject(key, body);
        await this.persistence.markArchived(
          group.map((e) => e.globalSeq),
          key,
        );
        objects.push(key);
      }

      return { archivedCount: events.length, objects };
    });
  }

  /** Groups events into `events/year=YYYY/month=MM/` partitions. */
  private partitionByMonth(events: ArchivableEvent[]): Map<string, ArchivableEvent[]> {
    const groups = new Map<string, ArchivableEvent[]>();
    for (const e of events) {
      const d = e.createdAtDate;
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const prefix = `events/year=${year}/month=${month}/`;
      const bucket = groups.get(prefix);
      if (bucket) bucket.push(e);
      else groups.set(prefix, [e]);
    }
    return groups;
  }
}

function stripInternal(e: ArchivableEvent) {
  const { createdAtDate, ...rest } = e;
  return rest;
}

/**
 * Periodic driver for the archiver, mirroring the project's cron pattern
 * (see RevocationCron). Defaults to a daily pass.
 */
export class ColdStorageCron {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly archiver: ColdStorageArchiver,
    private readonly intervalMs: number = 24 * 60 * 60 * 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        await this.archiver.archiveOnce();
      } catch (err) {
        console.error('Cold storage archival failed:', err);
      }
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
