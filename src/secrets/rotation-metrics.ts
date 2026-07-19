import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';

export const secretRotationAttemptsTotal = new Counter({
  name: 'secret_rotation_attempts_total',
  help: 'Total secret rotation attempts by target and result.',
  labelNames: ['target', 'type', 'result'] as const,
  registers: [metricsRegistry],
});

export const secretRotationDurationSeconds = new Histogram({
  name: 'secret_rotation_duration_seconds',
  help: 'Secret rotation duration in seconds.',
  labelNames: ['target', 'type'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const secretRotationLastSuccessTimestamp = new Gauge({
  name: 'secret_rotation_last_success_timestamp_seconds',
  help: 'Unix timestamp for the last successful secret rotation.',
  labelNames: ['target', 'type'] as const,
  registers: [metricsRegistry],
});

export const secretRotationStalenessSeconds = new Gauge({
  name: 'secret_rotation_staleness_seconds',
  help: 'Seconds since the last successful secret rotation.',
  labelNames: ['target', 'type'] as const,
  registers: [metricsRegistry],
});
