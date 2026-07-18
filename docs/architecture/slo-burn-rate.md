# Service Level Objective monitoring and burn-rate alerts

AgriTrust uses a system-wide availability SLO of 99.99% over a rolling 30-day window and a critical-path latency SLO of p99 under 100 ms. The implementation uses the existing Prometheus HTTP middleware metrics as the source of truth so every service path that passes through the API gateway is covered consistently.

## Architecture

1. `http_requests_total` provides total and 5xx request counts for availability calculations.
2. `http_request_duration_seconds_bucket` provides route-normalized latency histograms for critical-path p99 checks.
3. Prometheus recording rules in `monitoring/alerts/slo-burn-rate.yaml` precompute 5m, 30m, 1h, 2h, 6h, and 24h error ratios.
4. Multi-window alert rules page only when paired short and long windows burn the 0.01% error budget together, reducing noisy alerts from short traffic spikes.
5. Grafana imports `monitoring/dashboards/slo-overview.json` to display 30-day availability, burn rates, p99 latency, and error ratio.

## Core burn-rate logic

`src/slo/burn-rate.ts` implements the same policy used by Prometheus rules for tests, canary analysis, and future deployment automation. Burn rate is calculated as:

```text
observed error ratio / allowed error budget
```

For the 99.99% availability objective, the allowed error budget is `0.0001`. A 0.2% error ratio therefore burns at `20x` and would exhaust a 30-day budget in 36 hours if sustained.

## Alert policy

| Alert | Windows | Threshold | Action |
| --- | --- | ---: | --- |
| Fast burn page | 5m and 1h | 14.4x | Page the primary on-call immediately. |
| Slow burn page | 30m and 6h | 6x | Page the primary on-call and start incident coordination. |
| Ticket burn | 2h and 24h | 3x | Open a ticket and remediate during business hours unless worsening. |
| Critical-path latency | 5m route p99 | > 100 ms for 10m | Pause canary or roll back current deployment. |

## Deployment strategy

Roll out SLO monitoring with a blue-green deployment. Load recording rules and dashboards into the idle environment first, replay representative traffic, and verify rule evaluation before switching production traffic. During application releases, use canary stages at 5%, 25%, 50%, and 100%; promotion requires no active SLO page, p99 below 100 ms, and no 99.99% availability budget burn in the dashboard.

## Security review notes

The metrics use bounded labels (`method`, normalized `route`, and `status_code`) and do not include tenant IDs, tokens, payloads, or personally identifiable information. Dashboard and alert annotations reference services and SLO names only.
