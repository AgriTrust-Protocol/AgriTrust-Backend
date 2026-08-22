/**
 * AgriTrust Protocol – Environmental Logs Integration Test
 *
 * Inserts 1,000,000 synthetic environmental log rows using the
 * EnvironmentalLogWriter batch-insert path, then validates that a
 * 7-day rolling average query completes in under 2 seconds.
 *
 * Requirements:
 *   - DATABASE_URL environment variable must be set
 *   - TimescaleDB must be running at the target URL
 *   - The timescale_init.sql migration must have been applied
 */

import { Pool } from 'pg';
import { EnvironmentalLogWriter, generateSyntheticRow } from '../../src/sensors/writer';

const TARGET_ROW_COUNT = 1_000_000;
const SENSOR_COUNT = 100;
const ZONE_COUNT = 16;
const QUERY_TIMEOUT_MS = 2_000; // 2-second budget for 7-day aggregate

/**
 * Generate 1M rows spread across 100 sensors, 16 spatial zones,
 * and a 14-day time window (so the 7-day query has data to aggregate).
 */
function generateRowBatch(batchSize: number): ReturnType<typeof generateSyntheticRow>[] {
  const rows: ReturnType<typeof generateSyntheticRow>[] = [];
  const now = Date.now();
  const windowMs = 14 * 24 * 60 * 60 * 1_000; // 14 days in milliseconds

  for (let i = 0; i < batchSize; i++) {
    const sensorIndex = i % SENSOR_COUNT;
    const sensorId = `aaaaaaaa-${String(sensorIndex).padStart(4, '0')}-0000-0000-000000000000`;
    const timestamp = new Date(now - Math.random() * windowMs);
    const spatialZoneId = (sensorIndex % ZONE_COUNT) + 1;

    rows.push(generateSyntheticRow(sensorId, timestamp, spatialZoneId));
  }

  return rows;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const writer = new EnvironmentalLogWriter(pool, 500);

  // ----------------------------------------------------------
  // 1. Verify the hypertable exists
  // ----------------------------------------------------------
  const { rows: hypertableCheck } = await pool.query(`
    SELECT EXISTS (
      SELECT 1
      FROM _timescaledb_catalog.hypertable
      WHERE table_name = 'environmental_logs'
    ) AS has_hypertable
  `);

  if (!hypertableCheck[0]?.has_hypertable) {
    console.error('Hypertable environmental_logs does not exist. Run timescale_init.sql first.');
    await pool.end();
    process.exit(1);
  }

  console.log('✓ Hypertable environmental_logs exists');

  // ----------------------------------------------------------
  // 2. Verify spatial dimension
  // ----------------------------------------------------------
  const { rows: dimCheck } = await pool.query(`
    SELECT COUNT(*)::int AS dim_count
    FROM _timescaledb_catalog.dimension
    WHERE hypertable_id = (
      SELECT id FROM _timescaledb_catalog.hypertable WHERE table_name = 'environmental_logs'
    )
  `);

  console.log(`✓ Spatial dimensions: ${dimCheck[0]?.dim_count ?? 0}`);

  // ----------------------------------------------------------
  // 3. Batch-insert 1M synthetic rows
  // ----------------------------------------------------------
  console.log(`\nInserting ${TARGET_ROW_COUNT.toLocaleString()} rows in batches of 500...`);
  const insertStart = Date.now();
  const BATCH_SIZE = 500;
  const TOTAL_BATCHES = Math.ceil(TARGET_ROW_COUNT / BATCH_SIZE);

  for (let batch = 0; batch < TOTAL_BATCHES; batch++) {
    const rowsThisBatch = Math.min(BATCH_SIZE, TARGET_ROW_COUNT - batch * BATCH_SIZE);
    const syntheticBatch = generateRowBatch(rowsThisBatch);
    await writer.writeBatch(syntheticBatch);

    if ((batch + 1) % 200 === 0 || batch === TOTAL_BATCHES - 1) {
      const pct = (((batch + 1) / TOTAL_BATCHES) * 100).toFixed(1);
      console.log(
        `  Progress: ${((batch + 1) * BATCH_SIZE).toLocaleString()} / ${TARGET_ROW_COUNT.toLocaleString()} rows (${pct}%)`,
      );
    }
  }

  // Flush any remaining rows
  await writer.flush();
  const insertElapsed = Date.now() - insertStart;
  const actualInserted = writer.getTotalInserted();
  console.log(`✓ Inserted ${actualInserted.toLocaleString()} rows in ${insertElapsed}ms`);

  if (actualInserted < TARGET_ROW_COUNT) {
    console.error(`Expected ${TARGET_ROW_COUNT} rows but only inserted ${actualInserted}`);
    await writer.close();
    await pool.end();
    process.exit(1);
  }

  // ----------------------------------------------------------
  // 4. Run the 7-day rolling average query
  // ----------------------------------------------------------
  console.log('\nRunning 7-day rolling average query...');
  const queryStart = Date.now();

  const queryResult = await pool.query(`
    SELECT
      sensor_id,
      time_bucket('1 hour', timestamp) AS bucket,
      AVG(soil_moisture)  AS avg_soil_moisture,
      AVG(soil_ph)        AS avg_soil_ph,
      AVG(ambient_temp)   AS avg_ambient_temp,
      AVG(humidity)       AS avg_humidity,
      AVG(solar_radiation) AS avg_solar_radiation
    FROM environmental_logs
    WHERE timestamp >= NOW() - INTERVAL '7 days'
    GROUP BY sensor_id, bucket
    ORDER BY sensor_id, bucket
  `);

  const queryElapsed = Date.now() - queryStart;
  const rowCount = queryResult.rowCount ?? 0;

  console.log(`  Returned ${rowCount} aggregate rows in ${queryElapsed}ms`);

  // ----------------------------------------------------------
  // 5. Assert query time < 2 seconds
  // ----------------------------------------------------------
  if (queryElapsed > QUERY_TIMEOUT_MS) {
    console.error(`✗ FAIL: 7-day query took ${queryElapsed}ms (budget: ${QUERY_TIMEOUT_MS}ms)`);
    await writer.close();
    await pool.end();
    process.exit(1);
  }

  console.log(`✓ PASS: 7-day query completed in ${queryElapsed}ms (budget: ${QUERY_TIMEOUT_MS}ms)`);

  // ----------------------------------------------------------
  // 6. Verify compression policy exists
  // ----------------------------------------------------------
  const { rows: compressionPolicies } = await pool.query(`
    SELECT job_id, schedule_interval, proc_name, proc_schema
    FROM timescaledb_information.jobs
    WHERE proc_name LIKE '%compression%'
      AND hypertable_name = 'environmental_logs'
  `);

  if (compressionPolicies.length === 0) {
    console.error('Compression policy not found on environmental_logs');
    await writer.close();
    await pool.end();
    process.exit(1);
  }
  const cp = compressionPolicies[0];
  console.log(`✓ Compression policy active: job #${cp.job_id} (${cp.proc_schema}.${cp.proc_name})`);

  // ----------------------------------------------------------
  // 7. Verify retention policy exists
  // ----------------------------------------------------------
  const { rows: retentionPolicies } = await pool.query(`
    SELECT job_id, schedule_interval, proc_name, proc_schema
    FROM timescaledb_information.jobs
    WHERE proc_name LIKE '%retention%'
      AND hypertable_name = 'environmental_logs'
  `);

  if (retentionPolicies.length === 0) {
    console.error('Retention policy not found on environmental_logs');
    await writer.close();
    await pool.end();
    process.exit(1);
  }
  const rp = retentionPolicies[0];
  console.log(`✓ Retention policy active: job #${rp.job_id} (${rp.proc_schema}.${rp.proc_name})`);

  // ----------------------------------------------------------
  // Done
  // ----------------------------------------------------------
  await writer.close();
  await pool.end();

  console.log('\n✓✓✓ ALL INTEGRATION TESTS PASSED ✓✓✓');
  process.exit(0);
}

main().catch((err) => {
  console.error('Integration test failed with error:', err);
  process.exit(1);
});
