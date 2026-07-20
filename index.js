// ─── Load .env file before anything else ──────────────────────────────────────
try { require('dotenv').config(); } catch {}

// ─── Configuration validation at startup ─────────────────────────────────────
try {
  const { configLoader } = require('./dist/src/config/loader');
  const { collectConfigMetrics } = require('./dist/src/config/config-monitoring');
  configLoader.load(); // validates all env vars, throws on failure
  configLoader.startHotReload(); // watches config file for changes
  if (typeof collectConfigMetrics === 'function') collectConfigMetrics();
  console.log('[config] Configuration validated successfully');
  console.log('[config] Hot-reload enabled');
} catch (e1) {
  try {
    const { configLoader } = require('./src/config/loader');
    const { collectConfigMetrics } = require('./src/config/config-monitoring');
    configLoader.load();
    configLoader.startHotReload();
    if (typeof collectConfigMetrics === 'function') collectConfigMetrics();
    console.log('[config] Configuration validated successfully');
    console.log('[config] Hot-reload enabled');
  } catch (err) {
    console.error('[config] Configuration validation failed:', err.message);
    process.exit(1);
  }
}

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

const isMtlsEnabled = process.env.MTLS_ENABLED === 'true';

app.use(express.json());

// ─── OpenAPI request/response validation middleware ───────────────────────────
let openApiMiddleware;
try {
  openApiMiddleware = require('./src/middleware/openapi-validator').openApiValidationMiddleware;
} catch {
  openApiMiddleware = require('./dist/src/middleware/openapi-validator').openApiValidationMiddleware;
}
app.use(openApiMiddleware);

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

app.get('/openapi.json', async (_req, res) => {
  try {
    let loader;
    try {
      loader = require('./src/openapi/spec-loader');
    } catch {
      loader = require('./dist/src/openapi/spec-loader');
    }

    const spec = await loader.getMergedOpenApiDocument();
    res.status(200).json(spec);
  } catch (err) {
    console.error('Failed to serve OpenAPI spec:', err);
    res.status(500).json({ error: 'OpenAPI spec unavailable' });
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

// ─── Certificate Minting Service & Routes ───────────────────────────────────
try {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Use compiled JS files from dist
  const { MintService } = require('./dist/src/certificate/mintService');
  const { BatchEventListener } = require('./dist/src/events/batchEventListener');
  const { createBatchRouter } = require('./dist/src/api/routes/batchRoutes');

  const mintService = new MintService(pool);

  // Start Event Listener
  const eventListener = new BatchEventListener(mintService);
  if (process.env.NODE_ENV !== 'test') {
    eventListener.start();
  }

  // Mount API Routes
  app.use('/api/v1/batches', createBatchRouter(mintService));
} catch (err) {
  console.warn('Certificate minting modules not found or failed to load. Skipping init.');
}

// ─── Saga Orchestration Coordinator (Escrow Settlement) ─────────────────────
// Multi-step escrow settlement (hold → verify → release) with compensating
// actions and a persistent execution log. See issue #43.
try {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const { SagaCoordinator } = require('./dist/src/settlement/saga-coordinator');
  const { SagaLogStore } = require('./dist/src/database/saga_log');
  const { EscrowEngine, buildSettlementSaga } = require('./dist/src/settlement/escrow-engine');
  const { createSagaRouter } = require('./dist/src/api/routes/sagaRoutes');

  const sagaLogStore = new SagaLogStore(pool);
  const sagaCoordinator = new SagaCoordinator(sagaLogStore);

  // Register the escrow settlement definition so failed sagas can be retried.
  sagaCoordinator.registerDefinition(
    buildSettlementSaga(new EscrowEngine(), { escrowId: '', amount: 0 }),
  );

  // Admin/debug endpoints: GET /admin/sagas/:id and POST /admin/sagas/:id/retry
  app.use('/admin/sagas', createSagaRouter(sagaCoordinator, sagaLogStore));
} catch (err) {
  console.warn('Saga orchestration modules not found or failed to load. Skipping init.');
}

// ─── Event Sourcing Event Store Metrics ─────────────────────────────────────
// Registers the `event_store_read_duration_ms` summary against the unified
// metrics registry at boot so it surfaces on GET /metrics. See issue #42.
try {
  require('./dist/src/api/metrics/event_store_metrics');
} catch {
  try {
    require('./src/api/metrics/event_store_metrics');
  } catch {
    console.warn('Event store metrics module not found. Skipping registration.');
  }
}

// ─── Job Queue — Weighted Fair Queue Scheduler (Issue #44) ──────────────────
// Background job priority scheduler with deficit round-robin and per-type
// concurrency budgets. Backed by Redis sorted sets. See issue #44.
try {
  const { JobRegistry } = require('./dist/src/job-queue/job-registry');
  const { JobQueuePersistence } = require('./dist/src/job-queue/persistence');
  const { WorkerPool } = require('./dist/src/job-queue/worker-pool');
  const { Scheduler } = require('./dist/src/job-queue/scheduler');
  const { createAdminJobsRouter } = require('./dist/src/api/routes/adminJobsRoutes');
  const { DEFAULT_JOB_CONFIGS } = require('./dist/src/config/jobs');

  const registry = new JobRegistry();
  const persistence = new JobQueuePersistence(process.env.REDIS_URL || 'redis://localhost:6379');
  const workerPool = new WorkerPool(20);
  const scheduler = new Scheduler(registry, persistence, workerPool);

  // Register job type handlers (dummy handlers — real ones wired by the service layer).
  for (const type of Object.keys(DEFAULT_JOB_CONFIGS)) {
    registry.register(type, async (payload) => {
      console.log(`[JobQueue] Handling ${type}:`, JSON.stringify(payload).slice(0, 200));
    });
  }

  // Mount admin API under /admin/jobs
  app.use('/admin', createAdminJobsRouter(scheduler, persistence, workerPool));

  // Start the scheduler tick loop in production.
  if (process.env.NODE_ENV !== 'test') {
    persistence.connect()
      .then(() => { scheduler.start(); })
      .catch((err) => console.warn('Redis unavailable — job queue disabled:', err.message));
    console.log('Job queue scheduler started.');
  }
} catch (err) {
  console.warn('Job queue modules not found or failed to load. Skipping init.');
  console.warn(err instanceof Error ? err.message : String(err));
}

// ─── Configuration Management API ────────────────────────────────────────────
// Admin endpoints for viewing, reloading, and validating config at runtime.
// Sensitive values are redacted in responses.
try {
  const { createConfigRouter } = require('./dist/src/config/config-api');
  app.use('/admin/config', createConfigRouter());
} catch {
  try {
    const { createConfigRouter } = require('./src/config/config-api');
    app.use('/admin/config', createConfigRouter());
  } catch (err) {
    console.warn('Config API router not available. Skipping mount.');
  }
}

if (isMtlsEnabled) {
  (async () => {
    try {
      let gatewayModule;
      let registryModule;
      let revocationServiceModule;
      let revocationCronModule;
      try {
        gatewayModule = require('./dist/src/api/gateway/tls_config');
        registryModule = require('./dist/src/devices/registry');
        revocationServiceModule = require('./dist/src/devices/revocation_service');
        revocationCronModule = require('./dist/src/devices/revocation_cron');
      } catch {
        gatewayModule = require('./src/api/gateway/tls_config');
        registryModule = require('./src/devices/registry');
        revocationServiceModule = require('./src/devices/revocation_service');
        revocationCronModule = require('./src/devices/revocation_cron');
      }
      const { createMtlsServer, getMtlsServerConfigFromEnv } = gatewayModule;
      const { DeviceRegistry } = registryModule;
      const { CertificateRevocationService } = revocationServiceModule;
      const { RevocationCron } = revocationCronModule;
      const { Pool } = require('pg');

      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const registry = new DeviceRegistry(pool);
      await registry.refreshRevokedSerials();
      const cron = new RevocationCron(new CertificateRevocationService(pool));
      cron.start();

      const server = createMtlsServer(app, registry, getMtlsServerConfigFromEnv());
      server.listen(port, () => console.log(`Grant mTLS API running on port ${port}`));
    } catch (err) {
      console.error('Failed to start mTLS server:', err);
      process.exit(1);
    }
  })();
} else {
  app.listen(port, () => console.log('Grant API running'));
}
