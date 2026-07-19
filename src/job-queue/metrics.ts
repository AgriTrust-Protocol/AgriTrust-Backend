import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';

export const jobLeaseClaimsTotal = new Counter({
  name: 'job_scheduler_lease_claims_total',
  help: 'Total number of job lease claim attempts by result',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

export const jobLeaseClaimDurationSeconds = new Histogram({
  name: 'job_scheduler_lease_claim_duration_seconds',
  help: 'Duration of Redis-backed job lease claim operations in seconds',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

export const jobLeasesActive = new Gauge({
  name: 'job_scheduler_leases_active',
  help: 'Number of jobs currently held under a worker lease',
  registers: [metricsRegistry],
});

export const jobLeaseReclaimsTotal = new Counter({
  name: 'job_scheduler_lease_reclaims_total',
  help: 'Total number of expired job leases reclaimed for retry',
  registers: [metricsRegistry],
});
