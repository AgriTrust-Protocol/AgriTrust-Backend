# Per-Tenant Token Bucket Rate Limiting

## Architecture

AgriTrust applies a system-wide Express middleware that resolves the tenant from the authenticated `tenantContext` populated by auth middleware, then falls back to `X-Tenant-Id` and finally `anonymous`. Each tenant owns an independent token bucket, preventing one tenant from starving another tenant while keeping the critical path in-memory and O(1).

Policies are selected in this order:

1. tenant-specific overrides for contractual or incident response limits;
2. tier defaults for tier 1, 2, and 3 tenants;
3. the global default policy.

The default deployment should place this middleware immediately after authentication and before route handlers. Blue-green rollouts can start with mirrored metric observation in the green stack, then enable enforcement for a 5% canary, expand to 25%, and promote when throttling/error-rate deltas are acceptable.

## Performance and Availability

The limiter performs a single map lookup, arithmetic refill, and metric update per request. This avoids remote calls on the hot path and is designed to keep rate-limit decisions well under the 100 ms P99 target. Multi-instance deployments should either use sticky tenant routing or replace the in-memory bucket store with Redis using the same token-bucket contract and a Lua script for atomic refill/consume.

## Monitoring and Alerting

Prometheus metrics exported by the middleware:

- `tenant_rate_limit_check_duration_ms`: decision latency histogram.
- `tenant_rate_limit_decisions_total`: allow/throttle decision counter by tenant and tier.
- `tenant_rate_limit_throttled_total`: rejected request counter by tenant and tier.
- `tenant_rate_limit_bucket_tokens`: current bucket token gauge.

Suggested alerts:

- P99 decision latency above 100 ms for 5 minutes.
- Any tier 1 tenant with throttled requests for 2 consecutive minutes.
- Sudden increase in anonymous throttling, which can indicate credential abuse or missing auth propagation.

Dashboard panels should include decision latency, top throttled tenants, throttle ratio by tier, and bucket-token saturation.

## Runbook

1. Identify affected tenants from `tenant_rate_limit_throttled_total`.
2. Confirm whether the traffic matches expected seasonality, an integration retry storm, or suspicious abuse.
3. For legitimate bursts, apply a tenant-specific capacity/refill override and redeploy through the canary path.
4. For abuse, keep enforcement enabled and coordinate with security to block credentials or source networks.
5. After mitigation, verify HTTP 429 rates return to baseline and remove temporary overrides.
