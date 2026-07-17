# Graceful Degradation Runbook

## Detection

Check `/health/resilience` for the current capacity signal and feature flag snapshot. Prometheus should alert on sustained high `resilience_capacity_score` or unexpected request shedding.

## Mitigation

1. Confirm critical paths (`/health`, `/metrics`, certification reads) are still responding.
2. Disable non-critical features with environment flags, for example `FEATURE_WEBHOOK_DELIVERY=disabled`.
3. Increase worker capacity or reduce upstream traffic if `resilience_capacity_score` remains above `0.9`.
4. Keep background jobs paused until `resilience_shed_requests_total` stops increasing.

## Rollback

Restore feature flag environment variables to their default values and redeploy the previous blue environment if critical traffic receives `503` responses.
