# Capacity Planning with Historical Usage Trending

## Architecture

`HistoricalUsagePlanner` records bounded historical resource samples per service and resource, then computes deterministic forecasts from utilization growth over time. The planner is intentionally in-process and side-effect free except for Prometheus gauges, so services can run it on existing telemetry without adding write-path latency to critical API requests.

Inputs are normalized `UsageSample` records containing service, resource, used amount, provisioned capacity, and timestamp. Forecasts return current utilization, projected utilization at the planning horizon, growth per hour, time to the critical threshold, and a recommended capacity target sized to the configured target utilization.

## Performance and availability bounds

Capacity planning runs off scrape, batch, or control-plane paths rather than request middleware. Forecasting is O(n) over tracked service/resource keys for `forecastAll()` and O(1) for an individual service/resource after samples are selected, keeping critical paths under the 100 ms P99 target. If the planner is unavailable, application traffic continues because capacity samples are advisory telemetry.

## Security

Samples must use service names and resource labels only; do not include tenant identifiers, credentials, hostnames, or customer payload data. Metrics expose aggregate utilization ratios and forecast horizons suitable for authenticated Prometheus scraping.

## Deployment

Deploy behind the existing blue-green process. Enable metric collection in green first, route a 5% canary, compare planner latency, `/metrics` scrape size, current utilization, projected utilization, and application P99 latency for 30 minutes, then progress to 25%, 50%, and 100% if SLOs remain healthy.
