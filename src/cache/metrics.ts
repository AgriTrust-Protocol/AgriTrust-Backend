import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';

export const cacheOperationDurationMs = new Histogram({
  name: 'cache_operation_duration_ms',
  help: 'Cache operation duration in milliseconds',
  labelNames: ['operation', 'result'] as const,
  buckets: [1, 5, 10, 25, 50, 75, 100, 250, 500],
  registers: [metricsRegistry],
});

export const cacheRequestsTotal = new Counter({
  name: 'cache_requests_total',
  help: 'Total cache requests by operation and result',
  labelNames: ['operation', 'result'] as const,
  registers: [metricsRegistry],
});

export function recordCacheOperation(operation: string, result: string, durationMs: number): void {
  cacheOperationDurationMs.observe({ operation, result }, durationMs);
  cacheRequestsTotal.inc({ operation, result });
}

export function resetCacheMetrics(): void {
  cacheOperationDurationMs.reset();
  cacheRequestsTotal.reset();
}
