import { Pool, PoolClient } from 'pg';

export const continuousAggregateSql = [
  `CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_readings_hourly AS
   SELECT farm_id, sensor_type, date_trunc('hour', ts) AS bucket,
          avg(value) AS avg_value, min(value) AS min_value, max(value) AS max_value, count(*) AS reading_count
   FROM sensor_readings
   GROUP BY farm_id, sensor_type, date_trunc('hour', ts)
   WITH NO DATA`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_readings_daily AS
   SELECT farm_id, sensor_type, date_trunc('day', ts) AS bucket,
          avg(value) AS avg_value, min(value) AS min_value, max(value) AS max_value, count(*) AS reading_count
   FROM sensor_readings
   GROUP BY farm_id, sensor_type, date_trunc('day', ts)
   WITH NO DATA`,
  `CREATE OR REPLACE FUNCTION refresh_sensor_reading_aggregates() RETURNS void LANGUAGE plpgsql AS $$
   BEGIN
     REFRESH MATERIALIZED VIEW CONCURRENTLY sensor_readings_hourly;
     REFRESH MATERIALIZED VIEW CONCURRENTLY sensor_readings_daily;
   END $$`,
];

export const aggregateRefreshCron = '*/5 * * * *';

export async function ensureContinuousAggregates(client: Pool | PoolClient): Promise<void> {
  for (const sql of continuousAggregateSql) {
    await client.query(sql);
  }
}

export async function refreshContinuousAggregates(client: Pool | PoolClient): Promise<void> {
  await client.query('SELECT refresh_sensor_reading_aggregates()');
}
