/**
 * AgriTrust Backend – Unified Prometheus Registry
 *
 * Aggregates every metric family (runtime, pool, ledger, HTTP middleware)
 * into a single prom-client Registry so a single GET /metrics scrape
 * returns the full picture.
 *
 * Each sub-module registers its metrics against this registry at import time,
 * so simply importing this file (or any consumer) is enough to wire everything.
 */

import { Registry, Gauge, Histogram, Counter } from 'prom-client';

// ─── Central registry ──────────────────────────────────────────────────────

const metricsRegistry = new Registry();

// ─── Soroban RPC Metrics ──────────────────────────────────────────────────

export const rpcPoolSize = new Gauge({
  name: 'rpc_pool_size',
  help: 'Number of Soroban RPC nodes by status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const rpcRequestDurationMs = new Histogram({
  name: 'rpc_request_duration_ms',
  help: 'Soroban RPC request duration in milliseconds',
  labelNames: ['node'] as const,
  buckets: [50, 100, 250, 500, 1000, 2500, 5000],
  registers: [metricsRegistry],
});

export const rpcErrorTotal = new Counter({
  name: 'rpc_error_total',
  help: 'Total number of Soroban RPC errors',
  labelNames: ['node', 'code'] as const,
  registers: [metricsRegistry],
});

export { metricsRegistry };
