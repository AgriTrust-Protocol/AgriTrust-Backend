import { Counter, Gauge } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';

export const replicationLagSeconds = new Gauge({
  name: 'replication_lag_seconds',
  help: 'Observed replication lag between source and target regions in seconds',
  labelNames: ['source_region', 'target_region'] as const,
  registers: [metricsRegistry],
});

export const replicationBytesShippedTotal = new Counter({
  name: 'replication_bytes_shipped_total',
  help: 'Total CRDT delta bytes shipped to replica regions',
  labelNames: ['source_region', 'target_region'] as const,
  registers: [metricsRegistry],
});
