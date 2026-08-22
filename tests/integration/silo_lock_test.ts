import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';

const CONCURRENT_WORKERS = 50;
const DEPOSITS_PER_WORKER = 100;
const SILO_ID = 1;
const BIN_ID = 1;
const TICKET_WEIGHT = 100;

const WORKER_PATH = resolve(__dirname, 'silo_lock_worker.mjs');

interface WorkerMessage {
  workerId: number;
  successCount: number;
  failCount: number;
  errors: string[];
}

function runWorker(workerId: number): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        workerId,
        siloId: SILO_ID,
        binId: BIN_ID,
        ticketWeight: TICKET_WEIGHT,
        deposits: DEPOSITS_PER_WORKER,
      },
    });

    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker ${workerId} exited with code ${code}`));
    });
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  console.log(
    `Starting concurrency test with ${CONCURRENT_WORKERS} workers x ${DEPOSITS_PER_WORKER} deposits each`,
  );
  console.log(
    `Expected final balance: ${CONCURRENT_WORKERS * DEPOSITS_PER_WORKER * TICKET_WEIGHT} kg`,
  );

  const startTime = Date.now();

  const workerPromises: Promise<WorkerMessage>[] = [];
  for (let i = 0; i < CONCURRENT_WORKERS; i++) {
    workerPromises.push(runWorker(i));
  }

  const results = await Promise.all(workerPromises);
  const elapsed = Date.now() - startTime;

  const totalSuccess = results.reduce((sum, r) => sum + r.successCount, 0);
  const totalFails = results.reduce((sum, r) => sum + r.failCount, 0);
  const allErrors = results.flatMap((r) => r.errors);

  console.log(`\nTest completed in ${elapsed}ms`);
  console.log(`Total successful deposits: ${totalSuccess}`);
  console.log(`Total failed deposits: ${totalFails}`);

  if (allErrors.length > 0) {
    console.log(`\nSample errors (first 5):`);
    allErrors.slice(0, 5).forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query(
    'SELECT balance FROM silo_bins WHERE silo_id = $1 AND bin_id = $2',
    [SILO_ID, BIN_ID],
  );

  const finalBalance = rows.length > 0 ? parseFloat(rows[0].balance) : 0;
  const expectedBalance = CONCURRENT_WORKERS * DEPOSITS_PER_WORKER * TICKET_WEIGHT;

  console.log(`Final balance in silo_bins: ${finalBalance} kg`);
  console.log(`Expected balance: ${expectedBalance} kg`);

  if (finalBalance === expectedBalance) {
    console.log('\n✓ TEST PASSED: No inventory drift detected');
    await pool.end();
    process.exit(0);
  } else {
    console.log(`\n✗ TEST FAILED: Drift of ${expectedBalance - finalBalance} kg detected`);
    await pool.end();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
