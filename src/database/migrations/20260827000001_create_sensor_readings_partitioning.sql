-- AgriTrust Protocol – Time-Series Optimization for Agricultural Sensor Data (#166)
--
-- Implements a pure-PostgreSQL time-series storage layer for high-throughput
-- sensor telemetry, with no external TimescaleDB dependency.
--
--   sensor_readings                   – declaratively partitioned parent table.
--   trg_sensor_readings_auto_partition – auto-creates the daily partition an
--                                     inbound row lands in.
--   ensure_sensor_readings_partition() – creates a day partition if missing.
--   ensure_sensor_readings_indexes()   – creates per-partition BRIN + partial GIN.
--   detach_sensor_readings_partition() – detaches the oldest partition once the
--                                     90-day rolling window is exceeded and
--                                     records it in sensor_readings_archives so
--                                     a worker can export it to Parquet.
--   sensor_readings_hourly_agg         – hourly continuous aggregate (MATVIEW).
--   sensor_readings_daily_agg          – daily continuous aggregate (MATVIEW).
--   sp_refresh_sensor_aggregates()    – REFRESH MATERIALIZED VIEW CONCURRENTLY.
--   sp_detach_expired_sensor_data()   – enforced by the 5-min scheduled sweep.
--
-- The columnar access-method swap (pg_analytics / Citus) is applied separately
-- because it requires the `columnar` access method to be installed; see
-- src/db/compression.ts. Auto-vacuum tuning is applied in src/db/vacuum-tuning.ts.

-- migrate:up

-- ============================================================
-- 1. Parent partitioned table
-- ============================================================
CREATE TABLE IF NOT EXISTS sensor_readings (
    id            BIGSERIAL,
    farm_id       UUID        NOT NULL,
    sensor_type   TEXT        NOT NULL,
    ts            TIMESTAMPTZ NOT NULL,
    value         FLOAT8      NOT NULL,
    tags          JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (farm_id, ts, id)
) PARTITION BY RANGE (ts);

-- ============================================================
-- 2. Per-partition index strategy
--    BRIN (farm_id, ts) for time-range scans and a partial GIN (sensor_type,
--    tags) for JSONB metadata queries are created per partition. Declarative
--    partitions inherit no indexes from the parent, partial/BRIN indexes on a
--    partitioned parent carry version-specific restrictions, and BRIN is most
--    effective per-partition where time correlation is strong.
-- ============================================================
CREATE OR REPLACE FUNCTION ensure_sensor_readings_indexes(p_partition TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    -- BRIN over (farm_id, ts), 128-page range per partition.
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS idx_%I_ts_brin ON %I USING brin '
        '(farm_id, ts) WITH (pages_per_range = 128)'
        , p_partition, p_partition
    );
    -- Partial GIN over (sensor_type, tags) for JSONB tag predicates.
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS idx_%I_type_tags ON %I USING gin '
        '(sensor_type, tags) WHERE value IS NOT NULL'
        , p_partition, p_partition
    );
END;
$$;

-- ============================================================
-- 3. Daily partition bootstrap and insert auto-creation
-- ============================================================
CREATE OR REPLACE FUNCTION ensure_sensor_readings_partition(p_ts TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_day DATE := (p_ts AT TIME ZONE 'UTC')::DATE;
    v_partition TEXT := 'sensor_readings_' || TO_CHAR(v_day, 'YYYY_MM_DD');
    v_table TEXT;
BEGIN
    SELECT to_regclass('public.' || v_partition) INTO v_table;
    IF v_table IS NULL THEN
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF sensor_readings '
            'FOR VALUES FROM (%L) TO (%L)',
            v_partition,
            v_day,
            v_day + 1
        );
        -- Indexes are created once when the partition is created.
        PERFORM ensure_sensor_readings_indexes(v_partition);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION trg_sensor_readings_auto_partition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM ensure_sensor_readings_partition(NEW.ts);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sensor_readings_auto_partition ON sensor_readings;
CREATE TRIGGER trg_sensor_readings_auto_partition
    BEFORE INSERT ON sensor_readings
    FOR EACH ROW
    EXECUTE FUNCTION trg_sensor_readings_auto_partition();

-- Backfill indexes on any partitions created before this migration ran.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT child.relname AS partition_name
        FROM pg_inherits
        JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
        JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
        WHERE parent.relname = 'sensor_readings'
    LOOP
        PERFORM ensure_sensor_readings_indexes(r.partition_name);
    END LOOP;
END;
$$;

-- ============================================================
-- 4. 90-day rolling window – detach oldest partition, stage for Parquet
-- ============================================================
CREATE TABLE IF NOT EXISTS sensor_readings_archives (
    partition_name  TEXT PRIMARY KEY,
    partition_start DATE        NOT NULL,
    archived_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    parquet_path    TEXT,                -- set by the Parquet export worker
    status          TEXT        NOT NULL DEFAULT 'staged'
);

CREATE OR REPLACE FUNCTION detach_sensor_readings_partition(
    p_partition TEXT DEFAULT NULL     -- specific partition to detach, or NULL to
                                      -- detach the oldest expired one
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_partition TEXT;
    v_day DATE;
    v_expiry DATE := (NOW() AT TIME ZONE 'UTC')::DATE - 90;
BEGIN
    IF p_partition IS NULL THEN
        -- No explicit target: detach the single oldest partition.
        SELECT child.relname
        INTO v_partition
        FROM pg_inherits
        JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
        JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
        WHERE parent.relname = 'sensor_readings'
        ORDER BY child.relname ASC
        LIMIT 1;
        IF v_partition IS NULL THEN
            RETURN NULL;
        END IF;
    ELSE
        v_partition := p_partition;
    END IF;

    v_day := REPLACE(v_partition, 'sensor_readings_', '')::DATE;
    IF v_day > v_expiry THEN
        -- Still inside the 90-day window; leave it attached.
        RETURN NULL;
    END IF;

    -- Detach so the partition becomes a standalone table without blocking
    -- writes to newer partitions.
    EXECUTE format('ALTER TABLE sensor_readings DETACH PARTITION %I', v_partition);

    INSERT INTO sensor_readings_archives (partition_name, partition_start)
    VALUES (v_partition, v_day)
    ON CONFLICT (partition_name) DO NOTHING;

    RETURN v_partition;
END;
$$;

-- ============================================================
-- 5. Continuous aggregates – hourly and daily summaries
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_readings_hourly_agg
AS
SELECT
    farm_id,
    sensor_type,
    date_trunc('hour', ts)          AS bucket,
    AVG(value) AS avg_value,
    MIN(value) AS min_value,
    MAX(value) AS max_value,
    COUNT(*)   AS sample_count
FROM sensor_readings
GROUP BY farm_id, sensor_type, date_trunc('hour', ts)
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_readings_hourly_agg_pk
    ON sensor_readings_hourly_agg (farm_id, sensor_type, bucket);

CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_readings_daily_agg
AS
SELECT
    farm_id,
    sensor_type,
    date_trunc('day', ts)           AS bucket,
    AVG(value) AS avg_value,
    MIN(value) AS min_value,
    MAX(value) AS max_value,
    COUNT(*)   AS sample_count
FROM sensor_readings
GROUP BY farm_id, sensor_type, date_trunc('day', ts)
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_readings_daily_agg_pk
    ON sensor_readings_daily_agg (farm_id, sensor_type, bucket);

-- ============================================================
-- 6. Scheduled maintenance – refresh aggregates + detach expires
--    Runs every 5 minutes. An advisory lock serialises overlapping runs so a
--    slow refresh in one worker never races a second one.
-- ============================================================
CREATE OR REPLACE FUNCTION sp_refresh_sensor_aggregates()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('agritrust:sensor_readings_maintenance'));
    REFRESH MATERIALIZED VIEW CONCURRENTLY sensor_readings_hourly_agg;
    REFRESH MATERIALIZED VIEW CONCURRENTLY sensor_readings_daily_agg;
    PERFORM detach_sensor_readings_partition();
END;
$$;

CREATE OR REPLACE FUNCTION sp_detach_expired_sensor_data()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM detach_sensor_readings_partition();
END;
$$;

-- migrate:down
DROP TRIGGER IF EXISTS trg_sensor_readings_auto_partition ON sensor_readings;
DROP FUNCTION IF EXISTS trg_sensor_readings_auto_partition;
DROP FUNCTION IF EXISTS ensure_sensor_readings_indexes(TEXT);
DROP FUNCTION IF EXISTS ensure_sensor_readings_partition(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS detach_sensor_readings_partition;
DROP FUNCTION IF EXISTS sp_refresh_sensor_aggregates;
DROP FUNCTION IF EXISTS sp_detach_expired_sensor_data;
DROP MATERIALIZED VIEW IF EXISTS sensor_readings_hourly_agg;
DROP MATERIALIZED VIEW IF EXISTS sensor_readings_daily_agg;
DROP TABLE IF EXISTS sensor_readings_archives;
DROP TABLE IF EXISTS sensor_readings;