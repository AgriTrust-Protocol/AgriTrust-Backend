/**
 * AgriTrust Protocol – Index Strategy (#166)
 *
 * Central registry of the access paths that keep `sensor_readings` fast under
 * high write throughput:
 *
 *   idx_<partition>_ts_brin   – BRIN on (farm_id, ts) with pages_per_range=128.
 *                             Ideal for time-range aggregations over append-only
 *                             data because neighbouring rows share the same
 *                             block range.
 *   idx_<partition>_type_tags – partial GIN on (sensor_type, tags) for JSONB
 *                             metadata / tag queries.
 *
 * The indexes are created per daily partition (see the associated migration):
 * declarative partitions inherit no indexes from the parent, partial / BRIN
 * indexes on a partitioned parent carry version-specific restrictions, and BRIN
 * is most effective per-partition where the partition key already correlates
 * time. The migration backfills indexes on pre-existing partitions.
 */

import { Pool } from 'pg';

export const SENSOR_READINGS = 'sensor_readings';

export interface IndexDefinition {
  templateName: string; // name template with {table} placeholder
  ddlTemplate: string; // DDL with {index} and {table} placeholders
  description: string;
}

/** Quote an identifier for safe interpolation into DDL. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * BRIN over (farm_id, ts) per partition. `pages_per_range = 128` trades the
 * min/max metadata granularity for a compact index – ideal when each 128-page
 * range covers a short span of time within a single day.
 */
export const BRIN_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS {index} ON {table} USING brin
    (farm_id, ts) WITH (pages_per_range = 128)
`;

/**
 * Partial GIN over (sensor_type, tags) per partition – only rows that carry a
 * value (and therefore tags) are indexed, keeping the index small.
 */
export const PARTIAL_GIN_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS {index} ON {table} USING gin
    (sensor_type, tags) WHERE value IS NOT NULL
`;

export const INDEX_STRATEGY: IndexDefinition[] = [
  {
    templateName: 'idx_{table}_ts_brin',
    ddlTemplate: BRIN_INDEX_DDL,
    description: 'BRIN over (farm_id, ts) with pages_per_range=128 for fast time-range scans.',
  },
  {
    templateName: 'idx_{table}_type_tags',
    ddlTemplate: PARTIAL_GIN_INDEX_DDL,
    description: 'Partial GIN over (sensor_type, tags) for JSONB metadata queries.',
  },
];

const PARTITION_RE = /^sensor_readings_\d{4}_\d{2}_\d{2}$/;

export class IndexStrategy {
  constructor(
    private readonly pool: Pool,
    private readonly indexes: IndexDefinition[] = INDEX_STRATEGY,
  ) {}

  /**
   * Apply every index definition to a single named partition. Safe to re-run.
   * Partition names are produced by our own planner (pg_inherits) and validated
   * against a strict naming pattern before interpolation into DDL.
   */
  async ensureOnPartition(partition: string): Promise<string[]> {
    if (!PARTITION_RE.test(partition)) {
      throw new Error(`Refusing to index unexpected partition name: ${partition}`);
    }
    const created: string[] = [];
    const quoted = quoteIdent(partition);
    for (const index of this.indexes) {
      const indexName = index.templateName.replace('{table}', partition);
      const sql = index.ddlTemplate
        .replace(/\{table\}/g, quoted)
        .replace(/\{index\}/g, quoteIdent(indexName));
      await this.pool.query(sql);
      created.push(indexName);
    }
    return created;
  }

  /** Apply every index definition to all attached partitions. */
  async ensureAll(): Promise<string[]> {
    const partitions = await this.listPartitions();
    const ensured: string[] = [];
    for (const partition of partitions) {
      ensured.push(...(await this.ensureOnPartition(partition)));
    }
    return ensured;
  }

  private async listPartitions(): Promise<string[]> {
    const { rows } = await this.pool.query<{ relname: string }>(
      `
      SELECT child.relname AS relname
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

  /** True when a partition carries an index named by the strategy template. */
  async verify(partition: string, templateName: string): Promise<boolean> {
    const indexName = templateName.replace('{table}', partition);
    const { rows } = await this.pool.query(
      `
      SELECT COUNT(*)::int AS count
        FROM pg_indexes
       WHERE tablename = $1 AND indexname = $2
      `,
      [partition, indexName],
    );
    return rows[0]?.count > 0;
  }

  async verifyAll(): Promise<Record<string, boolean>> {
    const partitions = await this.listPartitions();
    const result: Record<string, boolean> = {};
    for (const partition of partitions) {
      for (const index of this.indexes) {
        const indexName = index.templateName.replace('{table}', partition);
        result[`${partition}.${indexName}`] = await this.verify(partition, index.templateName);
      }
    }
    if (partitions.length === 0) {
      // No partitions yet; report the strategy as vacuously consistent.
      result['no_partitions'] = true;
    }
    return result;
  }
}
