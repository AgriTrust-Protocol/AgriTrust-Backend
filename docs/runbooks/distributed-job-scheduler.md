# Runbook: Distributed Job Scheduler Leases

## Symptoms

- `JobSchedulerLeaseClaimLatencyHigh` fires.
- `JobSchedulerLeaseClaimErrors` fires.
- Queue depth rises while worker utilisation is low.
- `job_scheduler_leases_active` grows continuously.

## Immediate checks

1. Check Redis latency and CPU for the primary shard that owns `jobq:*` keys.
2. Inspect `/admin/jobs/queue` and confirm active jobs include recent `leaseExpiresAt` values.
3. Compare `job_scheduler_lease_claims_total{result="claimed"}` with enqueue rate.
4. Confirm canary and green deployment replicas use unique scheduler IDs.

## Mitigation

1. If leases are expired, wait one scheduler tick or restart one scheduler replica to trigger `reclaimExpiredLeases()`.
2. If claim latency exceeds 100ms P99, reduce worker pool size or shift traffic back to blue.
3. If a job type is saturated, use `/admin/jobs/workers/resize` only after verifying downstream capacity.
4. If Redis is degraded, pause new job ingestion and preserve existing `jobq:*` keys for recovery.

## Blue-green deployment

1. Deploy green with one scheduler replica enabled.
2. Watch lease claim latency, claim errors, and active leases for 15 minutes.
3. Increase green scheduler replicas by 25% increments while reducing blue.
4. Roll back if claim errors are non-zero for 5 minutes or active leases grow without corresponding completions.
