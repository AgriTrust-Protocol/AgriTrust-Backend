# Cache Layer Runbook

## Disable cache safely

Set `CACHE_ENABLED=false` and redeploy or restart the affected process. The cache layer is fail-open, so services continue using their source-of-truth loaders.

## Investigate high latency

1. Check `cache_operation_duration_ms` P99 for `get` and `set`.
2. Verify Redis CPU, memory, network latency, and connection saturation.
3. Lower `CACHE_OPERATION_TIMEOUT_MS` if application P99 is at risk.
4. Disable cache if Redis instability affects critical paths.

## Investigate low hit rate

1. Confirm keys include stable identifiers and do not contain request-specific entropy.
2. Check TTL settings against expected data reuse windows.
3. Compare canary hit rate with the previous blue deployment before full rollout.
