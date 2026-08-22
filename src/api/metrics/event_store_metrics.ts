/**
 * AgriTrust Backend – Event Store Metrics
 *
 * Exposes a Prometheus Summary `event_store_read_duration_ms` labelled by
 * operation type (append, rehydrate, snapshot, archive). Registered against the
 * unified metricsRegistry so it surfaces on the standard GET /metrics scrape.
 */

import { Summary } from 'prom-client';
import { metricsRegistry } from './registry';

export type EventStoreOperation = 'append' | 'rehydrate' | 'snapshot' | 'archive' | 'read';

export const eventStoreReadDuration = new Summary({
  name: 'event_store_read_duration_ms',
  help: 'Duration of event store operations in milliseconds, by operation type',
  labelNames: ['operation'],
  percentiles: [0.5, 0.9, 0.99],
  registers: [metricsRegistry],
});

/**
 * Times an async operation and records its duration against the summary.
 * The duration is observed even when the operation throws.
 */
export async function timed<T>(operation: EventStoreOperation, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    eventStoreReadDuration.observe({ operation }, Date.now() - start);
  }
}
