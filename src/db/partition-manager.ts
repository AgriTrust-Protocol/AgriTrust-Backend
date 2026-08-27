/**
 * AgriTrust Protocol – Partition Manager (#166)
 *
 * Daily range-partition lifecycle management for the `sensor_readings`
 * time-series table:
 *
 *   1. `ensureDailyPartition(ts)` – create the partition a given row belongs
 *      to (mirrors the server-side `ensure_sensor_readings_partition()`).
 *   2. `detachExpiredPartitions()` – detach partitions older than the 90-day
 *      rolling window and stage them in `sensor_readings_archives` so the
 *      Parquet export worker can archive them off-line.
 *   3. `archiveStagedPartitions()` – called by the Parquet export worker after
 *      a staged partition has been written; records the object path.
 *
 * The heavy lifting happens server-side (see the migration), these helpers give
 * the application a typed, testable handle on the same lifecycle.
 */

import { Pool, PoolClient } from 'pg';

export const SENSOR_READINGS = 'sensor_readings';
export const ARCHIVE_LEDGER = 'sensor_readings_archives';
export const ROLLING_WINDOW_DAYS = 90;

export interface DetachResult {
  partitionName: string;
  detached: boolean;
}

export interface ArchiveRecord {
  partitionName: string;
  partitionStart: string;
  archivedAt: Date;
  parquetPath: string | null;
  status: string;
}

export const PARTITION_PREFIX = 'sensor_readings_';

/** Convert a Date to the UTC day-string used in partition names. */
export function dayPartitionName(ts: Date): string {
  const y = ts.getUTCFullYear();
  const m = String(ts.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ts.getUTCDate()).padStart(2, '0');
  return `${PARTITION_PREFIX}${y}_${m}_${d}`;
}

/** Parse the day out of a partition name, e.g. `sensor_readings_2026_08_27`. */
export function partitionNameToDate(name: string): Date | null {
  const match = name.match(new RegExp(`^${PARTITION_PREFIX}(\\d{4})_(\\d{2})_(\\d{2})$`));
  if (!match) return null;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
}

export class PartitionManager {
  constructor(
    private readonly pool: Pool,
    private readonly windowDays: number = ROLLING_WINDOW_DAYS,
  ) {}

  /**
   * Ensure a partition exists for a given timestamp, delegating to the
   * server-side `ensure_sensor_readings_partition()` which also creates the
   * per-partition indexes. Returns the partition name.
   */
  async ensureDailyPartition(ts: Date): Promise<string> {
    const name = dayPartitionName(ts);
    if (await this.partitionExists(name)) return name;

    await this.pool.query('SELECT ensure_sensor_readings_partition($1::timestamptz)', [ts]);
    return name;
  }

  /** True when the named daily partition already exists. */
  async partitionExists(name: string): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT to_regclass($1) AS rel`, [`public.${name}`]);
    return rows[0]?.rel != null;
  }

  /**
   * Detach and stage every partition whose day is older than the rolling
   * window. Safe to call on every maintenance sweep; no-ops when the newest
   * partition is still within the window.
   */
  async detachExpiredPartitions(client?: PoolClient): Promise<DetachResult[]> {
    const c = client ?? this.pool;
    const cutoff = new Date(Date.now());
    cutoff.setUTCDate(cutoff.getUTCDate() - this.windowDays);

    const { rows } = await c.query<{ partition_name: string; partition_day: Date }>(
      `
      SELECT child.relname AS partition_name,
             REPLACE(child.relname, $1, '')::date AS partition_day
      FROM pg_inherits
      JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
      JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
      WHERE parent.relname = $2
        AND REPLACE(child.relname, $1, '')::date <= $3::date
      ORDER BY child.relname ASC
      `,
      [PARTITION_PREFIX, SENSOR_READINGS, cutoff],
    );

    const results: DetachResult[] = [];
    for (const row of rows) {
      // Detach the specific expired partition so app bookkeeping and the
      // server action can never drift apart, regardless of row ordering.
      const { rows: out } = await c.query<{ detached_name: string | null }>(
        'SELECT detach_sensor_readings_partition($1) AS detached_name',
        [row.partition_name],
      );
      const detachedName = out[0]?.detached_name ?? null;
      results.push({ partitionName: row.partition_name, detached: detachedName !== null });
    }
    return results;
  }

  /** List partitions still attached to the parent. */
  async listPartitions(): Promise<string[]> {
    const { rows } = await this.pool.query<{ relname: string }>(
      `
      SELECT child.relname
      FROM pg_inherits
      JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
      JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
      WHERE parent.relname = $1
      ORDER BY child.relname ASC
      `,
      [SENSOR_READINGS],
    );
    return rows.map((r) => r.relname);
  }

  /**
   * Record a staged partition as exported so the retention sweep can drop the
   * underlying table afterward.
   */
  async markArchived(partitionName: string, parquetPath: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${ARCHIVE_LEDGER}
         SET parquet_path = $2,
             status = 'archived'
       WHERE partition_name = $1
      `,
      [partitionName, parquetPath],
    );
  }

  /** Rows in the archive ledger, newest first. */
  async listArchives(client?: PoolClient): Promise<ArchiveRecord[]> {
    const c = client ?? this.pool;
    const { rows } = await c.query<ArchiveRecord>(
      `
      SELECT partition_name,
             partition_start,
             archived_at,
             parquet_path,
             status
        FROM ${ARCHIVE_LEDGER}
       ORDER BY archived_at DESC
      `,
    );
    return rows;
  }
}
