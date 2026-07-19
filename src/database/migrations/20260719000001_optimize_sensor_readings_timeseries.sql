-- migrate:up
-- Native PostgreSQL time-series layout for high-throughput agricultural sensors.
CREATE TABLE IF NOT EXISTS sensor_readings (
  id BIGSERIAL,
  farm_id UUID NOT NULL,
  sensor_id UUID,
  sensor_type TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  unit TEXT,
  tags JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

ALTER TABLE sensor_readings SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_analyze_threshold = 1000
);

CREATE INDEX IF NOT EXISTS sensor_readings_farm_ts_brin
  ON sensor_readings USING BRIN (farm_id, ts) WITH (pages_per_range = 128);

CREATE INDEX IF NOT EXISTS sensor_readings_sensor_type_tags_gin
  ON sensor_readings USING GIN (tags jsonb_path_ops)
  WHERE sensor_type IS NOT NULL AND tags IS NOT NULL;

CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_readings_hourly AS
SELECT farm_id,
       sensor_type,
       date_trunc('hour', ts) AS bucket,
       avg(value) AS avg_value,
       min(value) AS min_value,
       max(value) AS max_value,
       count(*) AS reading_count
FROM sensor_readings
GROUP BY farm_id, sensor_type, date_trunc('hour', ts)
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_readings_daily AS
SELECT farm_id,
       sensor_type,
       date_trunc('day', ts) AS bucket,
       avg(value) AS avg_value,
       min(value) AS min_value,
       max(value) AS max_value,
       count(*) AS reading_count
FROM sensor_readings
GROUP BY farm_id, sensor_type, date_trunc('day', ts)
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS sensor_readings_hourly_unique
  ON sensor_readings_hourly (farm_id, sensor_type, bucket);
CREATE UNIQUE INDEX IF NOT EXISTS sensor_readings_daily_unique
  ON sensor_readings_daily (farm_id, sensor_type, bucket);

CREATE OR REPLACE FUNCTION refresh_sensor_reading_aggregates() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY sensor_readings_hourly;
  REFRESH MATERIALIZED VIEW CONCURRENTLY sensor_readings_daily;
END $$;

-- migrate:down
DROP FUNCTION IF EXISTS refresh_sensor_reading_aggregates();
DROP MATERIALIZED VIEW IF EXISTS sensor_readings_daily;
DROP MATERIALIZED VIEW IF EXISTS sensor_readings_hourly;
DROP TABLE IF EXISTS sensor_readings CASCADE;
