# Dead Letter Queue Runbook

## Triage

1. Check `GET /admin/jobs/queue` and confirm `deadLetterDepth`.
2. List recent failures with `GET /admin/jobs/dead-letter?limit=100`.
3. Group by `type`, `reason`, and `errorMessage` to identify systemic failures.
4. Check `job_dead_letter_total{type,reason}` and `job_retry_total{type}` in Prometheus dashboards.

## Replay

Replay only after the root cause is fixed or the payload has been verified as safe to process.

```bash
curl -X POST "$ADMIN_BASE_URL/admin/jobs/dead-letter/<job-id>/replay"
```

The replay endpoint removes the DLQ entry and enqueues the original payload with `retryCount` reset to `0`.

## Purge

Purge a DLQ entry only after audit review or when the payload is known to be unrecoverable.

```bash
curl -X DELETE "$ADMIN_BASE_URL/admin/jobs/dead-letter/<job-id>"
```

## Blue-green and canary rollout checks

- Deploy the DLQ-enabled build to the green environment.
- Send a canary job that intentionally fails with `retryLimit: 0` in staging.
- Confirm the entry appears in `GET /admin/jobs/dead-letter` and increments `job_dead_letter_total`.
- Replay the canary entry and confirm it returns to the live queue.
- Shift production traffic gradually while watching DLQ growth and job latency P99.
