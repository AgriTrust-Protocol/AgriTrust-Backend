-- AgriTrust Protocol – pgbench benchmark for sensor_readings (#166)
--
-- Measures the pure-PostgreSQL time-series layer: daily partition routing,
-- BRIN-indexed time-range scans after writes. Run against the migrated schema:
--
--   # ~1h of 500K rows/hour traffic (scale -N accounts for FARM_COUNT*BATCH rows)
--   pgbench -n -c 16 -j 8 -T 60 -f scripts/pgbench/timeseries-benchmark.sql \
--           -D farms=200 -D batch=500 postgres://...
--
-- Each "client" executes one script below. A single script run inserts N rows
-- (default: 100) for a pseudo-random farm from a population, so -c 16 processes
-- sustain aggregate insert throughput. Adjust --rate or -T to hit the target.
--
-- Benchmark both the "optimized" schema (partitions + BRIN + matviews) and a
-- control table (same shape, unpartitioned, no BRIN) by pointing the script at
-- different relation names, then compare rows/sec and query times.

\set farms 200
\set batch 100
\set zone 1 + ((:client_id + 1) % 16)
-- A stable pseudo-random farm per worker so ids reuse across the run.
\set farm_id md5(:client_id::text)

-- Route each insert to its daily partition via the BEFORE INSERT trigger
-- (auto-creates the partition for a new day).
INSERT INTO sensor_readings (farm_id, sensor_type, ts, value, tags)
SELECT
    :'farm_id'::uuid,
    'soil_moisture',
    now() - (random() * interval '90 days'),
    10 + random() * 40,
    jsonb_build_object('zone', :zone)
FROM generate_series(1, :batch);

-- Time-range scan the BRIN index path for a single farm over the last 7 days.
SELECT COUNT(*)
  FROM sensor_readings
 WHERE farm_id = :'farm_id'::uuid
   AND ts >= now() - interval '7 days';