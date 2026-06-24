const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// ─── HTTP Metrics Middleware ─────────────────────────────────────────────────
// Tracks request duration, response size, and status code per route.
let metricsMiddleware;
try {
  metricsMiddleware = require('./src/api/metrics/middleware').metricsMiddleware;
} catch {
  metricsMiddleware = require('./dist/src/api/metrics/middleware').metricsMiddleware;
}
app.use(metricsMiddleware);

app.get('/', (req, res) => {
  res.json({ 
    project: 'Grant Stream',
    status: 'Tracking Grants',
    contract: 'CD6OGC46OFCV52IJQKEDVKLX5ASA3ZMSTHAAZQIPDSJV6VZ3KUJDEP4D'
  });
});

app.get('/health/ledger-consistency', async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    const result = await pool.query(
      "SELECT COUNT(*) AS count, MIN(last_attempt) AS oldest FROM ledger_gaps WHERE status IN ('discovered', 'filling')",
    );
    await pool.end();

    const count = Number(result.rows[0]?.count ?? 0);
    const oldest = result.rows[0]?.oldest;

    res.json({
      unresolvedGaps: count,
      oldestGapAgeSeconds: oldest
        ? Math.floor((Date.now() - new Date(oldest).getTime()) / 1000)
        : 0,
      healthy: count === 0,
    });
  } catch (err) {
    res.status(503).json({
      error: 'Ledger consistency check failed',
      healthy: false,
    });
  }
});

app.use('/health', (() => {
  try {
    return require('./src/health/routes').createHealthRouter();
  } catch {
    return require('./dist/src/health/routes').createHealthRouter();
  }
})());

/**
 * GET /metrics
 *
 * Unified Prometheus scrape endpoint — returns ALL metric families
 * (runtime, pool, ledger, HTTP) in a single scrape.
 */
app.get('/metrics', async (_req, res) => {
  try {
    let mod;
    try {
      mod = require('./src/api/metrics/runtime_metrics');
    } catch {
      mod = require('./dist/src/api/metrics/runtime_metrics');
    }

    const { getAllMetricsText, startCollecting } = mod;
    startCollecting();

    const metrics = await getAllMetricsText();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(metrics);
  } catch (err) {
    console.error('Failed to scrape metrics:', err);
    res.status(500).send('# Error collecting metrics\n');
  }
});

/**
 * GET /metrics/runtime
 *
 * Backward-compatible runtime-only metrics endpoint.
 */
app.get('/metrics/runtime', async (_req, res) => {
  try {
    let runtimeMetrics;
    try {
      runtimeMetrics = require('./src/api/metrics/runtime_metrics');
    } catch {
      runtimeMetrics = require('./dist/src/api/metrics/runtime_metrics');
    }

    const { getRuntimeMetricsText, startCollecting } = runtimeMetrics;
    startCollecting();

    const metrics = await getRuntimeMetricsText();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(metrics);
  } catch (err) {
    console.error('Failed to scrape runtime metrics:', err);
    res.status(500).send('# Error collecting runtime metrics\n');
  }
});

/**
 * GET /debug/metrics/check
 *
 * Self-test endpoint that validates all expected metric families are
 * present and registered. Returns PASS/FAIL with details.
 */
app.get('/debug/metrics/check', async (_req, res) => {
  let debugCheck;
  try {
    debugCheck = require('./src/api/metrics/debug_check');
  } catch {
    debugCheck = require('./dist/src/api/metrics/debug_check');
  }

  await debugCheck.debugMetricsCheckHandler(_req, res);
});

app.listen(port, () => console.log('Grant API running'));
