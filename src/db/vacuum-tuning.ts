/**
 * AgriTrust Protocol – Auto-Vacuum Tuning (#166)
 *
 * Auto-vacuum tuning for high-write tables. The default scale factor (0.2)
 * means a table must churn ~20% of its rows before a vacuum is triggered,
 * which is far too lenient for append-heavy time-series tables. Tuning down to
 * a 1% scale factor with an absolute threshold of 1,000 rows keeps dead tuple
 * build-up bounded on the hot `sensor_readings` partition chain.
 */

import { Pool } from 'pg';

export interface VacuumTuningPolicy {
  table: string;
  vacuumScaleFactor: number;
  vacuumThreshold: number;
}

export const SENSOR_READINGS = 'sensor_readings';

export const VACUUM_SCALE_FACTOR = 0.01;
export const VACUUM_THRESHOLD = 1_000;

const APPLY_SQL = `
ALTER TABLE %I SET (
    autovacuum_vacuum_scale_factor = %L,
    autovacuum_vacuum_threshold = %L
)
`;

export const DEFAULT_TUNING: VacuumTuningPolicy = {
  table: SENSOR_READINGS,
  vacuumScaleFactor: VACUUM_SCALE_FACTOR,
  vacuumThreshold: VACUUM_THRESHOLD,
};

export class VacuumTuning {
  constructor(private readonly pool: Pool) {}

  /**
   * Apply the aggressive vacuum policy to a given table. The table name is
   * identifier-quoted to resist injection.
   */
  async apply(table: string = SENSOR_READINGS): Promise<void> {
    await this.pool.query(APPLY_SQL, [
      table,
      String(VACUUM_SCALE_FACTOR),
      String(VACUUM_THRESHOLD),
    ]);
  }

  /** Apply tuning to `sensor_readings` and every attached partition. */
  async applyToPartitionedTable(): Promise<string[]> {
    const applied: string[] = [];
    await this.apply(SENSOR_READINGS);
    applied.push(SENSOR_READINGS);

    const { rows } = await this.pool.query<{ partition_name: string }>(
      `
      SELECT child.relname AS partition_name
        FROM pg_inherits
        JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
        JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
       WHERE parent.relname = $1
       ORDER BY child.relname ASC
      `,
      [SENSOR_READINGS],
    );
    for (const row of rows) {
      await this.apply(row.partition_name);
      applied.push(row.partition_name);
    }
    return applied;
  }
}

export { VACUUM_SCALE_FACTOR as scaleFactor, VACUUM_THRESHOLD as threshold };
