/**
 * AgriTrust Protocol – Time-Series Benchmark (#166)
 *
 * pgbench-style simulation of high-throughput agricultural sensor ingestion.
 * Inserts 500K rows/hour worth of traffic into the partitioned `sensor_readings`
 * table and measures:
 *
 *   - Insert throughput (rows/sec) and p99 per-row latency
 *   - Daily aggregate query latency over a 90-day window (budget ≤ 100 ms)
 *   - Raw per-farm query latency over a 7-day window (budget ≤ 500 ms)
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run benchmark:timeseries
 *
 * The migration `20260827000001` must be applied first.
 *
 * For a native pgbench run, see scripts/pgbench/timeseries-benchmark.sql.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { TimeSeriesOptimizer, OptimizationReport } from '../src/db/time-series';

const ROWS_PER_HOUR = 500_000;
const FARM_COUNT = 200;
const BATCH_SIZE = 500;
const BUDGET_AGG_90D_MS = 100;
const BUDGET_RAW_7D_MS = 500;

function p99(times: number[]): number {
  if (times.length === 0) return 0;
  const sorted = [...times].sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(sorted.length * 0.99) - 1);
  return sorted[idx];
}

function printReport(report: OptimizationReport): void {
  console.log('Applied time-series optimisations:');
  console.log(
    `  indexes:        ok=${report.indexes.ok}  ${report.indexes.value?.length ?? 0} ensured`,
  );
  console.log(`  aggregates:     ok=${report.aggregates.ok}  refreshed=${report.aggregates.value}`);
  console.log(
    `  partitions:     ok=${report.partitions.ok}  detached=${report.partitions.value?.length ?? 0}`,
  );
  console.log(
    `  compression:    ok=${report.compression.ok}  cold=${report.compression.value?.length ?? 0}`,
  );
  console.log(
    `  vacuum tuned:   ok=${report.vacuum.ok}  ${report.vacuum.value?.length ?? 0} tables`,
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 20 });

  const optimizer = new TimeSeriesOptimizer(pool);
  const report = await optimizer.apply();
  printReport(report);
  console.log('');

  // Pre-generate the farm population so every insert and the follow-up raw
  // query exercise a real, populated partition range.
  const farms = Array.from({ length: FARM_COUNT }, () => randomUUID());

  // ----------------------------------------------------------
  // Insert benchmark
  // ----------------------------------------------------------
  const start = Date.now();
  const perBatchTimes: number[] = [];
  let inserted = 0;

  for (const farmId of farms) {
    const batchStart = Date.now();
    const values: Array<Array<string | number>> = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const ts = new Date(start - Math.random() * 90 * 24 * 60 * 60 * 1_000);
      values.push([
        farmId,
        'soil_moisture',
        ts.toISOString(),
        +(5 + Math.random() * 50).toFixed(2),
        `{"zone": ${(i % 16) + 1}}`,
      ]);
    }
    await pool.query(
      `
      INSERT INTO sensor_readings (farm_id, sensor_type, ts, value, tags)
      SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::timestamptz[], $4::float8[], $5::jsonb[])
      `,
      [
        values.map((v) => v[0]),
        values.map((v) => v[1]),
        values.map((v) => v[2]),
        values.map((v) => v[3]),
        values.map((v) => v[4]),
      ],
    );
    perBatchTimes.push(Date.now() - batchStart);
    inserted += values.length;
  }

  const insertElapsed = Date.now() - start;
  const perRowMs = perBatchTimes.map((t) => t / BATCH_SIZE);
  const insertP99 = p99(perRowMs);
  const throughput = (inserted / insertElapsed) * 1_000;

  console.log('Insert benchmark:');
  console.log(`  inserted:       ${inserted.toLocaleString()} rows`);
  console.log(`  elapsed:        ${insertElapsed}ms`);
  console.log(`  throughput:     ${Math.round(throughput).toLocaleString()} rows/sec`);
  console.log(`  p99 insert/row: ${insertP99.toExponential(2)}ms (amortised per batch)`);

  // ----------------------------------------------------------
  // Query benchmark – daily aggregate over 90 days (served by the matview)
  // ----------------------------------------------------------
  const aggQueryStart = Date.now();
  await pool.query(
    `
    SELECT bucket, AVG(avg_value) AS avg
      FROM sensor_readings_daily_agg
     WHERE bucket >= NOW() - INTERVAL '90 days'
     GROUP BY bucket
    `,
  );
  const aggElapsed = Date.now() - aggQueryStart;
  console.log('Query benchmark:');
  console.log(`  daily agg / 90 days:  ${aggElapsed}ms (budget ${BUDGET_AGG_90D_MS}ms)`);

  // ----------------------------------------------------------
  // Query benchmark – raw per-farm data over 7 days (a farm that was inserted)
  // ----------------------------------------------------------
  const targetFarm = farms[0];
  const rawQueryStart = Date.now();
  await pool.query(
    `
    SELECT farm_id, sensor_type, ts, value
      FROM sensor_readings
     WHERE farm_id = $1
       AND ts >= NOW() - INTERVAL '7 days'
    `,
    [targetFarm],
  );
  const rawElapsed = Date.now() - rawQueryStart;
  console.log(`  raw 1-farm/7-day:     ${rawElapsed}ms (budget ${BUDGET_RAW_7D_MS}ms)`);

  const ok =
    aggElapsed <= BUDGET_AGG_90D_MS &&
    rawElapsed <= BUDGET_RAW_7D_MS &&
    throughput >= Math.round(ROWS_PER_HOUR / 3600);
  console.log('');
  console.log(ok ? '✓ PASS: budgets met' : '✗ FAIL: budgets exceeded');
  await pool.end();
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}

export { main };
