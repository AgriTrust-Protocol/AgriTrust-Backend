# Redis-backed Cache Layer

AgriTrust services use `CacheService` as the single in-memory cache abstraction for critical reads. The cache is backed by Redis-compatible clients and is intentionally fail-open: when Redis is unavailable or exceeds the configured timeout, callers receive data from the loader path instead of failing the request.

## Architecture

- `CacheService.remember(key, loader, options)` checks Redis first, then calls the loader and stores JSON with an expiration.
- All keys are prefixed with `CACHE_NAMESPACE` to isolate environments and tenants.
- Default TTL is controlled with `CACHE_DEFAULT_TTL_SECONDS`; critical-path TTL is controlled with `CACHE_CRITICAL_PATH_TTL_SECONDS`.
- `CACHE_OPERATION_TIMEOUT_MS` should stay below the 100 ms P99 target; the default is 50 ms.
- Cache metrics are exported through the unified Prometheus registry.

## Operations

Prometheus metrics:

- `cache_operation_duration_ms` tracks latency by operation and result.
- `cache_requests_total` tracks hits, misses, successful writes, skipped writes, and errors.

Alert recommendations:

- Page when P99 `cache_operation_duration_ms` is above 100 ms for 10 minutes.
- Warn when cache error rate is above 1% for 5 minutes.
- Warn when hit rate drops below the service-specific baseline after deployment.

## Deployment

Use blue-green deployment with canary analysis:

1. Deploy cache-enabled code with conservative TTLs to the green environment.
2. Route 5% traffic for 15 minutes and compare P99 latency, error rate, and hit rate.
3. Increase to 25%, then 50%, then 100% if metrics remain healthy.
4. Roll back by setting `CACHE_ENABLED=false` or routing traffic back to blue.
