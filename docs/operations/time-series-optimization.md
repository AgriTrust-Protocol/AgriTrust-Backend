# Time-Series Database Optimization

This document describes the time-series storage layer for agricultural sensor
data. It implements issue **#166 – Time-Series Database Optimization for
Agricultural Sensor Data**: sustain high write throughput (500K sensor readings /
hour) while keeping time-range aggregation queries fast, using **plain
PostgreSQL** – no external TimescaleDB dependency.

## Storage Model

Sensor telemetry lives in the `sensor_readings` table, which is declaratively
partitioned by `RANGE (ts)` into one partition per UTC day:

| object                         | purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `sensor_readings`              | partitioned parent table                              |
| `sensor_readings_<YYYY_MM_DD>` | one daily partition per day                           |
| `sensor_readings_hourly_agg`   | hourly aggregate materialized view                    |
| `sensor_readings_daily_agg`    | daily aggregate materialized view                     |
| `sensor_readings_archives`     | ledger of detached partitions awaiting Parquet export |

### Partitioning

The migration `src/database/migrations/20260827000001_create_sensor_readings_partitioning.sql`
creates the parent and the supporting functions:

- `ensure_sensor_readings_partition(ts)` – creates a daily partition if missing.
- `trg_sensor_readings_auto_partition` – `BEFORE INSERT` trigger that routes each
  inbound row to its partition, auto-creating the partition on first write.

Inbound rows are inserted through the partition manager:

```ts
import { Pool } from 'pg';
import { PartitionManager } from '../src/db/partition-manager';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const partitions = new PartitionManager(pool);

// Auto-create the partition for the row's timestamp before the INSERT.
await partitions.ensureDailyPartition(new Date());
```

### Rolling window (90 days)

`detach_sensor_readings_partition()` runs on every 5-minute maintenance sweep
and detaches the oldest partition once it is older than 90 days. Detached
partitions are recorded in `sensor_readings_archives` (`status = 'staged'`) so
the Parquet export worker can:

1. `COPY` the detached table to Parquet,
2. record the object path with `PartitionManager.markArchived(...)`,
3. `DROP TABLE` the detached partition.

The window is configurable:

```ts
const partitions = new PartitionManager(pool, 90); // 90-day window
await partitions.detachExpiredPartitions();
```

### Index strategy

Two access paths are defined (see `src/db/index-strategy.ts`) and created on
**each daily partition** rather than on the partitioned parent – declarative
partitions inherit no indexes from the parent, partial / BRIN indexes on a
partitioned parent carry version-specific restrictions, and BRIN is most
effective per-partition where time is already well-correlated. The migration
backfills indexes on pre-existing partitions.

- `idx_<partition>_ts_brin` – BRIN on `(farm_id, ts)` with
  `pages_per_range = 128`. BRIN is ideal for append-only time-series data
  because adjacent rows share a block range, so per-farm time-range scans skip
  whole ranges instead of walking the tree.
- `idx_<partition>_type_tags` – partial GIN on `(sensor_type, tags)` for JSONB
  metadata / tag predicates. Partial means only rows with a value (and tags)
  are indexed.

```ts
import { IndexStrategy } from '../src/db/index-strategy';
const strategy = new IndexStrategy(pool);
await strategy.ensureAll(); // apply both indexes to every attached partition
const ok = await strategy.verifyAll(); // e.g. { 'sensor_readings_2026_08_27.…': true, ... }
```

### Continuous aggregates

Hourly and daily materialized views expose `avg` / `min` / `max` / `count`
per (`farm_id`, `sensor_type`, bucket). `sp_refresh_sensor_aggregates()`
refreshes both views `CONCURRENTLY` (non-blocking) every **5 minutes** via the
scheduler exposed by `src/db/continuous-aggregates.ts`:

```ts
import { ContinuousAggregates } from '../src/db/continuous-aggregates';
const aggregates = new ContinuousAggregates(pool);

// Run once on demand:
await aggregates.refresh();

// Or start the 5-minute in-process scheduler:
const scheduler = aggregates.start(); // defaults to 5 minutes
scheduler.stop();
```

### Columnar compression

Partitions older than 7 days are converted to the `columnar` access method
(pg_analytics / Citus) so cold ranges stay small and scan-efficient. The
conversion is optional: `ColumnarCompression.isColumnarAvailable()` probes
`pg_am` for the `columnar` access method and skips gracefully when the
extension is not installed.

```ts
import { ColumnarCompression } from '../src/db/compression';
const compression = new ColumnarCompression(pool, 7); // > 7 days is cold
const converted = await compression.convertColdPartitions();
```

### Auto-vacuum tuning

High-write time-series tables are tuned to
`autovacuum_vacuum_scale_factor = 0.01` with an absolute threshold of 1000 rows
(see `src/db/vacuum-tuning.ts`). The default 0.2 scale factor would otherwise
allow dead tuples to accumulate far too long on append-heavy tables.

```ts
import { VacuumTuning } from '../src/db/vacuum-tuning';
const tuning = new VacuumTuning(pool);
await tuning.applyToPartitionedTable();
```

## Orchestration

`src/db/time-series.ts` ties all steps together in an idempotent
`TimeSeriesOptimizer.apply()` that is safe to run on startup:

```ts
import { Pool } from 'pg';
import { TimeSeriesOptimizer } from '../src/db/time-series';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const optimizer = new TimeSeriesOptimizer(pool);
const report = await optimizer.apply();
console.log(report);
// {
//   indexes:     { ok: true, value: [...] }, aggregates: { ok: true, value: true },
//   partitions:  { ok: true, value: [...] }, compression: { ok: true, value: [...] },
//   vacuum:      { ok: true, value: [...] },
// }
// A failed step records `ok: false` with an `error` field while the other steps
// still run, so partial progress is never lost.
```

## Benchmark

Two benchmarks exercise the 500K rows/hour target with and without the
optimisations.

**In-process benchmark** – simulates the write load through the application
path and enforces the latency budgets stated in the issue:

```bash
DATABASE_URL=postgres://user:pass@host/db npm run benchmark:timeseries
```

It reports insert throughput, p99 per-row insert latency (amortised per batch),
the daily aggregate query time over a 90-day window (budget ≤ 100 ms), and the
raw 1-farm / 7-day query time (budget ≤ 500 ms), exiting non-zero when a budget
is missed. The raw query targets one of the farms that was actually inserted, so
it measures a real, populated partition range.

**Native pgbench script** – `scripts/pgbench/timeseries-benchmark.sql` drives
`pgbench` directly so you can compare the optimized schema against a control
(unpartitioned, no BRIN) table under identical load:

```bash
pgbench -n -c 16 -j 8 -T 60 -f scripts/pgbench/timeseries-benchmark.sql \
        -D farms=200 -D batch=100 postgres://user:pass@host/db
```

## Schema Expectations

The migration defines these server-side objects:

| object                                      | type     | notes                                     |
| ------------------------------------------- | -------- | ----------------------------------------- |
| `sensor_readings`                           | table    | partitioned by range on `ts`              |
| `ensure_sensor_readings_partition(ts)`      | function | idempotent partition creation             |
| `ensure_sensor_readings_indexes(partition)` | function | per-partition BRIN + partial GIN creation |
| `trg_sensor_readings_auto_partition`        | trigger  | before-insert partition routing           |
| `detach_sensor_readings_partition()`        | function | 90-day detach + archive staging           |
| `sp_refresh_sensor_aggregates()`            | function | concurrent refresh + sweep                |
| `sensor_readings_hourly_agg` / `_daily_agg` | matview  | continuous aggregates                     |
| `sensor_readings_archives`                  | table    | archival ledger for Parquet export        |
