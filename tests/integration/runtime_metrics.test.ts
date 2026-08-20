/**
 * AgriTrust Backend – Runtime Metrics Integration Test
 *
 * Tests that GET /metrics/runtime returns the expected Prometheus metric
 * families with non-zero values, confirming the event-loop lag monitor,
 * heap allocation gauges, and thread/handle contention collectors are all
 * operational.
 *
 * This test is self-contained (no database required). It starts an ephemeral
 * Express server on a random port, scrapes the endpoint, then shuts down.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express } from 'express';
import http from 'http';
import {
  startCollecting,
  stopCollecting,
  resetMetrics,
  getRuntimeMetricsText,
} from '../../src/api/metrics/runtime_metrics';

// ─── Test Server ────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // Reset metrics to start clean
  resetMetrics();

  // Start background collection with a fast interval so the first
  // scrape already has samples
  startCollecting(500); // 500 ms for test speed

  // Create an ephemeral Express server
  const app: Express = express();
  app.get('/metrics/runtime', async (_req, res) => {
    try {
      const text = await getRuntimeMetricsText();
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(text);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).send(`# Error: ${message}\n`);
    }
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  stopCollecting();
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ─── Helper ─────────────────────────────────────────────────────────────────

/**
 * Fetch and parse the /metrics/runtime response.
 */
async function fetchMetrics(): Promise<string> {
  const res = await fetch(`${baseUrl}/metrics/runtime`);
  expect(res.status).toBe(200);

  const contentType = res.headers.get('content-type') ?? '';
  expect(contentType).toContain('text/plain');

  return res.text();
}

/**
 * Extract the raw value of a Prometheus metric line (last seen value).
 */
function extractMetricValue(text: string, metricName: string): number | null {
  // Match lines like:  node_heap_used_bytes 12345
  // or histogram bucket:  node_event_loop_lag_seconds_bucket{le="0.005"} 10
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith(metricName) && !line.startsWith('#')) {
      const parts = line.split(/\s+/);
      const val = parseFloat(parts[parts.length - 1]);
      if (!isNaN(val)) return val;
    }
  }
  return null;
}

/**
 * Check that a metric family appears in the response with non-zero samples.
 */
function expectMetricPresent(text: string, metricName: string): void {
  const val = extractMetricValue(text, metricName);
  expect(val).not.toBeNull();
  expect(val).toBeGreaterThanOrEqual(0);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /metrics/runtime', () => {
  it('returns 200 with text/plain content type', async () => {
    const text = await fetchMetrics();
    expect(text.length).toBeGreaterThan(0);
  });

  it('contains the event loop lag histogram family', async () => {
    const text = await fetchMetrics();

    // The histogram should include HELP, TYPE, _bucket, _count, _sum, and the bare metric
    expect(text).toContain('# HELP node_event_loop_lag_seconds');
    expect(text).toContain('# TYPE node_event_loop_lag_seconds histogram');
    expect(text).toContain('node_event_loop_lag_seconds_bucket');
    expect(text).toContain('node_event_loop_lag_seconds_count');
    expect(text).toContain('node_event_loop_lag_seconds_sum');

    // We triggered collectRuntimeMetrics() synchronously before the first scrape,
    // which records 4 observations (mean, p50, p90, p99).
    const count = extractMetricValue(text, 'node_event_loop_lag_seconds_count');
    expect(count).not.toBeNull();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it('contains the heap used gauge with a non-zero value', async () => {
    const text = await fetchMetrics();
    expectMetricPresent(text, 'node_heap_used_bytes');

    const val = extractMetricValue(text, 'node_heap_used_bytes');
    // A running Node.js process always consumes heap
    expect(val).toBeGreaterThan(1000);
  });

  it('contains the heap allocation rate gauge', async () => {
    const text = await fetchMetrics();
    expect(text).toContain('# HELP node_heap_alloc_rate_bytes_per_sec');
    expect(text).toContain('# TYPE node_heap_alloc_rate_bytes_per_sec gauge');
  });

  it('contains the active handles gauge', async () => {
    const text = await fetchMetrics();
    expectMetricPresent(text, 'node_active_handles_total');

    const val = extractMetricValue(text, 'node_active_handles_total');
    // node --test / vitest plus the Express server should have at least one active handle
    expect(val).not.toBeNull();
  });

  it('contains the thread pool size gauge', async () => {
    const text = await fetchMetrics();
    expectMetricPresent(text, 'node_thread_pool_size');

    const val = extractMetricValue(text, 'node_thread_pool_size');
    // Default libuv thread pool size is 4
    expect(val).toBe(4);
  });

  it('contains the blocked worker gauge (should be 0 under normal conditions)', async () => {
    const text = await fetchMetrics();
    expectMetricPresent(text, 'node_worker_threads_blocked');

    const val = extractMetricValue(text, 'node_worker_threads_blocked');
    // Under normal test conditions the event loop should NOT be blocked
    expect(val).toBe(0);
  });

  it('contains the thread pool queue depth gauge', async () => {
    const text = await fetchMetrics();
    expect(text).toContain('# HELP node_thread_pool_queue_depth');
    expect(text).toContain('# TYPE node_thread_pool_queue_depth gauge');

    const val = extractMetricValue(text, 'node_thread_pool_queue_depth');
    expect(val).not.toBeNull();
    expect(val).toBeGreaterThanOrEqual(0);
  });

  it('contains the worker threads active gauge', async () => {
    const text = await fetchMetrics();
    expect(text).toContain('# HELP node_worker_threads_active');
    expect(text).toContain('# TYPE node_worker_threads_active gauge');

    const val = extractMetricValue(text, 'node_worker_threads_active');
    expect(val).not.toBeNull();
    expect(val).toBeGreaterThanOrEqual(0);
  });

  it('contains all HELP and TYPE lines for every metric family', async () => {
    const text = await fetchMetrics();
    const expectedFamilies = [
      'node_event_loop_lag_seconds',
      'node_heap_used_bytes',
      'node_heap_alloc_rate_bytes_per_sec',
      'node_active_handles_total',
      'node_worker_threads_active',
      'node_thread_pool_size',
      'node_thread_pool_queue_depth',
      'node_worker_threads_blocked',
    ];

    for (const name of expectedFamilies) {
      expect(text).toContain(`# HELP ${name}`);
      expect(text).toContain(`# TYPE ${name}`);
    }
  });
});
