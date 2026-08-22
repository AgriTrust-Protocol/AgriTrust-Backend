const http = require('http');
const { Worker, parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { MockSensor } = require('./mock-sensor');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const stats = {
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0,
  connections: 0,
  dropouts: 0,
  reconnections: 0,
  latencies: [],
  recordLatency(ms) {
    this.latencies.push(ms);
  },
  reset() {
    this.messagesSent = 0;
    this.messagesReceived = 0;
    this.errors = 0;
    this.connections = 0;
    this.dropouts = 0;
    this.reconnections = 0;
    this.latencies = [];
  },
};

function computePercentiles(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function writeJsonReport(report) {
  const outputPath = process.env.PERFORMANCE_REPORT_PATH;
  if (!outputPath) return;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
}

function printReport(stats, durationMs, sensorCount) {
  const durationSec = durationMs / 1000;
  const sorted = [...stats.latencies].sort((a, b) => a - b);

  console.log('\n=== Load Test Report ===');
  console.log(`Duration: ${durationSec.toFixed(1)}s`);
  console.log(`Sensors: ${sensorCount}`);
  console.log(`Messages Sent: ${stats.messagesSent}`);
  console.log(`Messages Received: ${stats.messagesReceived}`);
  console.log(`Throughput: ${(stats.messagesReceived / durationSec).toFixed(1)} msg/s`);
  console.log(
    `Error Rate: ${((stats.errors / Math.max(stats.messagesSent, 1)) * 100).toFixed(2)}%`,
  );
  console.log(`Connections: ${stats.connections}`);
  console.log(`Dropouts: ${stats.dropouts}`);
  console.log(`Reconnections: ${stats.reconnections}`);
  console.log(`\nLatency (ms):`);
  console.log(`  P50: ${computePercentiles(sorted, 50).toFixed(1)}`);
  console.log(`  P95: ${computePercentiles(sorted, 95).toFixed(1)}`);
  console.log(`  P99: ${computePercentiles(sorted, 99).toFixed(1)}`);
  console.log(`  Min: ${sorted[0]?.toFixed(1) ?? 'N/A'}`);
  console.log(`  Max: ${sorted[sorted.length - 1]?.toFixed(1) ?? 'N/A'}`);

  const sent = Math.max(stats.messagesSent, 1);
  const report = {
    samples: [
      {
        route: config.target.endpoint,
        p99Ms: computePercentiles(sorted, 99),
        errorRate: stats.errors / sent,
        availability: stats.messagesReceived / sent,
        sampleCount: sorted.length,
      },
    ],
  };
  writeJsonReport(report);

  const passed =
    stats.errors === 0 &&
    report.samples[0].p99Ms <= 100 &&
    report.samples[0].availability >= 0.9999 &&
    report.samples[0].sampleCount >= 25;
  if (!passed) {
    console.error(
      `Performance budget failed for ${config.target.endpoint}: P99=${report.samples[0].p99Ms.toFixed(1)}ms, availability=${report.samples[0].availability.toFixed(5)}, samples=${report.samples[0].sampleCount}`,
    );
  }
  return passed;
}

function runWorkerSimulation(sensorCount, durationMs) {
  return new Promise((resolve) => {
    const sensors = [];
    for (let i = 0; i < sensorCount; i++) {
      const sensor = new MockSensor({ ...config.simulation, target: config.target }, stats);
      sensors.push(sensor);
    }

    console.log(`Starting ${sensorCount} mock sensors for ${(durationMs / 1000).toFixed(0)}s...`);

    sensors.forEach((s) => s.run().catch(() => {}));

    const timer = setTimeout(() => {
      sensors.forEach((s) => s.stop());
      resolve(Date.now());
    }, durationMs);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const ciMode = args.includes('--ci');

  if (ciMode) {
    config.simulation.telemetryIntervalMs = { min: 100, max: 250 };
    config.simulation.jitterMs = { min: 0, max: 25 };
    config.simulation.outOfOrderProbability = 0;
    config.simulation.dropoutProbability = 0;
  }

  const sensorCount = ciMode ? config.simulation.ciSensorCount : config.simulation.sensorCount;
  const durationMs = ciMode ? config.simulation.ciTestDurationMs : config.simulation.testDurationMs;

  console.log(`AgriTrust Load Test (${ciMode ? 'CI' : 'full'} mode)`);
  console.log(
    `Target: http://${config.target.host}:${config.target.port}${config.target.endpoint}`,
  );

  const workerCount = config.workers;
  const sensorsPerWorker = Math.ceil(sensorCount / workerCount);

  if (!ciMode && workerCount > 1) {
    const workers = [];
    let completed = 0;

    for (let i = 0; i < workerCount; i++) {
      const count = i === workerCount - 1 ? sensorCount - i * sensorsPerWorker : sensorsPerWorker;

      const w = new Worker(__filename, {
        workerData: {
          sensorCount: count,
          durationMs,
          workerId: i,
        },
      });

      w.on('message', (msg) => {
        if (msg.type === 'done') {
          stats.messagesSent += msg.stats.messagesSent;
          stats.messagesReceived += msg.stats.messagesReceived;
          stats.errors += msg.stats.errors;
          stats.connections += msg.stats.connections;
          stats.dropouts += msg.stats.dropouts;
          stats.reconnections += msg.stats.reconnections;
          stats.latencies.push(...msg.stats.latencies);
          completed++;
          if (completed === workerCount) {
            const passed = printReport(stats, durationMs, sensorCount);
            process.exit(passed ? 0 : 1);
          }
        }
      });

      w.on('error', (err) => {
        console.error(`Worker ${i} error:`, err);
        completed++;
      });

      workers.push(w);
    }
  } else {
    const startTime = Date.now();
    await runWorkerSimulation(sensorCount, durationMs);
    const endTime = Date.now();
    const passed = printReport(stats, endTime - startTime, sensorCount);
    if (!passed) process.exit(1);
  }
}

if (workerData) {
  const { sensorCount, durationMs } = workerData;
  runWorkerSimulation(sensorCount, durationMs).then(() => {
    parentPort.postMessage({
      type: 'done',
      stats: {
        messagesSent: stats.messagesSent,
        messagesReceived: stats.messagesReceived,
        errors: stats.errors,
        connections: stats.connections,
        dropouts: stats.dropouts,
        reconnections: stats.reconnections,
        latencies: stats.latencies,
      },
    });
  });
} else {
  main().catch((err) => {
    console.error('Load test failed:', err);
    process.exit(1);
  });
}
