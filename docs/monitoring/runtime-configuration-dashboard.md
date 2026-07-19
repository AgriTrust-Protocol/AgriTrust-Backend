# Runtime Configuration Dashboard

Recommended panels:

- Audit latency P99: `histogram_quantile(0.99, sum by (le, service) (rate(runtime_config_audit_duration_ms_bucket[5m])))`
- Drift detections: `sum by (service, severity) (increase(runtime_config_drift_total[15m]))`
- Last audit age: `time() - runtime_config_last_audit_timestamp_seconds`
- Canary gate: `sum(increase(runtime_config_drift_total{severity="critical"}[10m])) == 0`

Recommended alerts:

- Page on any `critical` drift in production.
- Warn when audit latency P99 exceeds 100 ms for 10 minutes.
- Warn when a service has not audited configuration in two expected intervals.
