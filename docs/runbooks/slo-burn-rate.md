# SLO burn-rate alert runbook

Use this runbook for `AgriTrustAvailabilityFastBurn`, `AgriTrustAvailabilitySlowBurn`, `AgriTrustAvailabilityTicketBurn`, and `AgriTrustCriticalPathP99Latency`.

## Triage

1. Open the AgriTrust SLO Overview dashboard and identify whether availability burn, latency, or both are breaching.
2. Check recent blue-green or canary rollout status. If a canary is active, pause promotion immediately.
3. Compare the highest-error routes with deploy, dependency, database pool, cache, and Soroban RPC dashboards.
4. Confirm whether the issue affects all traffic or only a bounded route; route labels are normalized to avoid tenant or entity identifiers.

## Mitigation

- Fast or slow availability burn: roll back the latest deployment if correlated, shed optional traffic, and fail over unhealthy dependencies.
- Ticket burn: create a remediation ticket, assign an owner, and monitor for escalation to page thresholds.
- Critical-path latency: rollback or reduce canary traffic if p99 stays above 100 ms for 10 minutes; investigate database, cache, and external RPC latency.

## Recovery

1. Verify all active SLO alerts have resolved in Prometheus.
2. Confirm dashboard burn rates are trending below 1x and critical-path p99 is under 100 ms.
3. Resume canary promotion only after at least two clean 5-minute windows.
4. Record incident timeline, root cause, customer impact, and follow-up actions.
