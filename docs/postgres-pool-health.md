# PostgreSQL Connection Pool Health Probe and Adaptive Sizing

## Architecture

`MonitoredPool` wraps `pg.Pool` and is the single implementation used by services that need PostgreSQL access. The wrapper now runs a bounded `SELECT 1` health probe, records the latest health snapshot, and adjusts the configured pool maximum from live utilization and queue pressure.

Health is derived from probe latency, probe errors, active connections, idle capacity, and callers waiting on the pool:

- `healthy`: probe succeeds below the degraded latency threshold and the pool has spare capacity.
- `degraded`: probe succeeds but latency is elevated, utilization crosses the scale-up threshold, or callers are waiting.
- `unhealthy`: probe fails or exceeds the 100ms critical-path latency budget.

Adaptive sizing uses a conservative cooldown to avoid resize oscillation. Saturated or queued pools grow by 25% plus one connection up to `maxLimit`; healthy underused pools shrink by one connection down to `min`.

## Monitoring and alerting

The Prometheus pool collector exports:

- `pool_connections_active{pool}`
- `pool_connections_idle{pool}`
- `pool_connections_total{pool}`
- `pool_connections_waiting{pool}`
- `pool_probe_latency_ms{pool}`
- `pool_health_status{pool,status}`

Recommended alerts:

- Page when `pool_health_status{status="unhealthy"} == 1` for five minutes.
- Warn when `pool_health_status{status="degraded"} == 1` for ten minutes.
- Warn when `pool_probe_latency_ms > 75` for ten minutes.
- Page when `pool_connections_waiting > 0` for five minutes on critical services.

## Deployment runbook

1. Deploy the new build to the green environment with adaptive sizing enabled at the existing `max` value.
2. Shift 5% of traffic to green for 15 minutes and compare P99 request latency, pool waiters, and PostgreSQL server connection count against blue.
3. Increase traffic to 25%, 50%, and 100% only when canary metrics remain within SLO and no unhealthy pool alert fires.
4. Roll back to blue if pool waiters persist, probe latency exceeds 100ms, or database server connection usage approaches the PostgreSQL limit.

## Security considerations

The probe executes a constant `SELECT 1` statement without user input and does not log credentials or connection strings. Metrics expose aggregate pool counts only and must be scraped through the existing authenticated metrics path.
