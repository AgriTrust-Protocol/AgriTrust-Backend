/**
 * AgriTrust Protocol – Columnar Compression (#166)
 *
 * Converts partitions of `sensor_readings` older than `compressionAgeDays`
 * (default 7) to a columnar access method so cold ranges stay small on disk and
 * scan-efficient for aggregates, while the hot, recent partitions stay row-wise
 * for low-latency point writes.
 *
 * The swap uses `ALTER TABLE ... SET ACCESS METHOD columnar` from pg_analytics
 * / Citus. Because that access method is an installed extension it is not part
 * of the base migration; this module detects whether it is available and skips
 * gracefully when it is not (e.g. on a stock local PostgreSQL).
 */

import { Pool } from 'pg';

export const COLUMNAR_ACCESS_METHOD = 'columnar';
export const DEFAULT_COMPRESSION_AGE_DAYS = 7;

export class ColumnarCompression {
  constructor(
    private readonly pool: Pool,
    private readonly ageDays: number = DEFAULT_COMPRESSION_AGE_DAYS,
  ) {}

  /** True when the `columnar` access method is installed and usable. */
  async isColumnarAvailable(): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT 1 FROM pg_am WHERE amname = $1`, [
      COLUMNAR_ACCESS_METHOD,
    ]);
    return rows.length > 0;
  }

  /**
   * Convert every daily partition older than `ageDays` to the columnar access
   * method. Returns the list of partitions converted. No-ops when the columnar
   * access method is not installed.
   */
  async convertColdPartitions(): Promise<string[]> {
    if (!(await this.isColumnarAvailable())) return [];

    const cutoff = new Date(Date.now());
    cutoff.setUTCDate(cutoff.getUTCDate() - this.ageDays);

    const { rows } = await this.pool.query<{ partition_name: string }>(
      `
      SELECT child.relname AS partition_name
        FROM pg_inherits
        JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
        JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
       WHERE parent.relname = 'sensor_readings'
         AND REPLACE(child.relname, 'sensor_readings_', '')::date <= $1::date
       ORDER BY child.relname ASC
      `,
      [cutoff],
    );

    const converted: string[] = [];
    for (const row of rows) {
      await this.pool.query(`ALTER TABLE ${row.partition_name} SET ACCESS METHOD columnar`);
      converted.push(row.partition_name);
    }
    return converted;
  }

  /** Report the access method currently in use for each attached partition. */
  async accessMethodSnapshot(): Promise<Array<{ partitionName: string; accessMethod: string }>> {
    const { rows } = await this.pool.query<{
      partition_name: string;
      access_method: string;
    }>(
      `
      SELECT child.relname AS partition_name, am.amname AS access_method
        FROM pg_inherits
        JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
        JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
        JOIN pg_am am        ON am.oid     = child.relam
       WHERE parent.relname = 'sensor_readings'
       ORDER BY child.relname ASC
      `,
    );
    return rows.map((r) => ({
      partitionName: r.partition_name,
      accessMethod: r.access_method,
    }));
  }
}
