# Dead Letter Queue Architecture

AgriTrust job processing uses Redis-backed priority queues plus a dedicated dead letter queue (DLQ) for terminal failures. The DLQ applies system-wide to all registered job types because failures are captured in the shared `WorkerPool` and routed by the shared `Scheduler`.

## Flow

1. The scheduler dequeues jobs by weighted priority.
2. Unknown job types are immediately written to the DLQ with reason `unknown_type`.
3. Registered jobs run in the worker pool with their configured timeout and retry budget.
4. Handler failures and timeouts are retried until the job type's `retryLimit` is exhausted.
5. Exhausted jobs are retained in Redis under `jobq:dlq:*` with payload, failure reason, error message, failed timestamp, and attempt count.
6. Operators can inspect, replay, or purge DLQ entries through admin job endpoints.

## Redis keys

- `jobq:dlq:jobs`: hash of dead-letter job id to serialized metadata.
- `jobq:dlq:index`: sorted set ordered by `failedAt` for newest-first listing.

## Monitoring

Prometheus metrics:

- `job_retry_total{type}` counts retry attempts scheduled after worker failures.
- `job_dead_letter_total{type,reason}` counts terminal DLQ writes by job type and reason.
- `GET /admin/jobs/queue` includes `deadLetterDepth` for dashboard gauges.

Suggested alert: page on-call when `job_dead_letter_total` increases for critical job types over a 5-minute window or when `deadLetterDepth` remains non-zero for more than 15 minutes.

## Performance and availability notes

DLQ writes use Redis hash and sorted-set operations and are only performed on failure paths, keeping successful critical-path processing below the existing scheduler and worker overhead. Replay uses one Redis transaction to atomically remove the DLQ entry and enqueue a fresh live job.
