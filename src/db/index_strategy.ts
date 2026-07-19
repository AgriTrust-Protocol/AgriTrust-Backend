import { Pool, PoolClient } from 'pg';
import { quoteIdentifier } from './sql_ident';

export interface SensorIndexOptions {
  tableName?: string;
  brinPagesPerRange?: number;
}

export function sensorReadingsIndexSql(options: SensorIndexOptions = {}): string[] {
  const table = quoteIdentifier(options.tableName ?? 'sensor_readings');
  const pagesPerRange = options.brinPagesPerRange ?? 128;
  return [
    `CREATE INDEX IF NOT EXISTS sensor_readings_farm_ts_brin ON ${table} USING BRIN (farm_id, ts) WITH (pages_per_range = ${pagesPerRange})`,
    `CREATE INDEX IF NOT EXISTS sensor_readings_sensor_type_tags_gin ON ${table} USING GIN (tags jsonb_path_ops) WHERE sensor_type IS NOT NULL AND tags IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS sensor_readings_hourly_aggregate_lookup ON sensor_readings_hourly (farm_id, sensor_type, bucket)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sensor_readings_hourly_unique ON sensor_readings_hourly (farm_id, sensor_type, bucket)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sensor_readings_daily_unique ON sensor_readings_daily (farm_id, sensor_type, bucket)`,
  ];
}

export async function applySensorIndexStrategy(client: Pool | PoolClient, options: SensorIndexOptions = {}): Promise<void> {
  for (const sql of sensorReadingsIndexSql(options)) {
    await client.query(sql);
  }
}
