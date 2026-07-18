/**
 * AgriTrust Backend – Connection Pool Prometheus Metrics
 *
 * Exposes gauges that mirror the internal state of MonitoredPool instances
 * for Prometheus scrape:
 *
 *   pool_connections_active{pool="oltp"}  – connections currently acquired
 *   pool_connections_active{pool="olap"}  – connections currently acquired
 *   pool_connections_idle{pool="oltp"}    – idle (available) connections
 *   pool_connections_idle{pool="olap"}    – idle (available) connections
 *
 * Registration pool names are supplied when calling registerPool() after
 * constructing a MonitoredPool.
 */

import { Gauge } from 'prom-client';
import { metricsRegistry } from './registry';
import { MonitoredPool } from '../../database/connection_pool';

// ─── Prometheus Gauge Definitions ───────────────────────────────────────────

export const poolConnectionsActive = new Gauge({
  name: 'pool_connections_active',
  help: 'Number of connections currently acquired from the pool',
  labelNames: ['pool'],
  registers: [metricsRegistry],
});

export const poolConnectionsIdle = new Gauge({
  name: 'pool_connections_idle',
  help: 'Number of idle (available) connections in the pool',
  labelNames: ['pool'],
  registers: [metricsRegistry],
});

export const poolConnectionsTotal = new Gauge({
  name: 'pool_connections_total',
  help: 'Maximum connections configured for the pool',
  labelNames: ['pool'],
  registers: [metricsRegistry],
});

export const poolHealthStatus = new Gauge({
  name: 'pool_health_status',
  help: 'PostgreSQL pool health by status (1 for current status, 0 otherwise)',
  labelNames: ['pool', 'status'],
  registers: [metricsRegistry],
});

export const poolProbeLatencyMs = new Gauge({
  name: 'pool_probe_latency_ms',
  help: 'Latest PostgreSQL pool health probe latency in milliseconds',
  labelNames: ['pool'],
  registers: [metricsRegistry],
});

export const poolConnectionsWaiting = new Gauge({
  name: 'pool_connections_waiting',
  help: 'Number of callers waiting for a PostgreSQL pool connection',
  labelNames: ['pool'],
  registers: [metricsRegistry],
});

// ─── Pool Registration ──────────────────────────────────────────────────────

interface PoolEntry {
  pool: MonitoredPool;
  name: string;
}

const registeredPools: PoolEntry[] = [];

/**
 * Register a MonitoredPool for Prometheus export.
 *
 * @param name  Logical pool name (e.g. "oltp", "olap").  Used as the `pool` label.
 * @param pool  The MonitoredPool instance to track.
 */
export function registerPool(name: string, pool: MonitoredPool): void {
  registeredPools.push({ pool, name });
}

/**
 * Update all registered pool gauges.  Called by the main collection loop.
 */
export function collectPoolMetrics(): void {
  for (const entry of registeredPools) {
    const { name, pool } = entry;
    const acquired = pool.getAcquired();
    const max = pool.getMaxConnections();
    const idle = Math.max(0, max - acquired);

    poolConnectionsActive.set({ pool: name }, acquired);
    poolConnectionsIdle.set({ pool: name }, idle);
    poolConnectionsTotal.set({ pool: name }, max);
    poolConnectionsWaiting.set({ pool: name }, pool.getWaitingCount());

    const health = pool.getLastHealth();
    if (health) {
      poolProbeLatencyMs.set({ pool: name }, health.latencyMs);
      for (const status of ['healthy', 'degraded', 'unhealthy'] as const) {
        poolHealthStatus.set({ pool: name, status }, health.status === status ? 1 : 0);
      }
    }
  }
}

/**
 * Unregister all pools (for testing).
 */
export function resetPoolMetrics(): void {
  registeredPools.length = 0;
  poolConnectionsActive.reset();
  poolConnectionsIdle.reset();
  poolConnectionsTotal.reset();
  poolConnectionsWaiting.reset();
  poolProbeLatencyMs.reset();
  poolHealthStatus.reset();
}
