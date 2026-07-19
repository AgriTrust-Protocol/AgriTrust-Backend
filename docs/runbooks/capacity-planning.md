# Capacity Planning Runbook

## Dashboards

Import `monitoring/dashboards/capacity-planning.json` and verify panels for current utilization, projected utilization, and hours to critical threshold. Use these panels with application P99 latency and availability dashboards before changing provisioned capacity.

## Alerts

Load `monitoring/alerts/capacity-planning.yaml` into Prometheus. Page when any service/resource is already above critical utilization or is forecast to cross the threshold within 24 hours. Warn when projected utilization exceeds the planning threshold across the configured horizon.

## Triage

1. Identify the service/resource pair in alert labels.
2. Confirm the trend against source telemetry and recent deploys.
3. Check whether P99 latency remains below 100 ms and availability remains at or above 99.99%.
4. Scale the bottlenecked resource to the recommended capacity target or reduce non-critical load.
5. Deploy capacity changes through blue-green with 5%, 25%, 50%, and 100% canary analysis.
6. Keep rollback ready until projected utilization and latency stabilize for at least 30 minutes.

## Security review

Review metric labels before enabling new sample sources. Labels must not contain tenant secrets, PII, raw device identifiers, connection strings, or payload fragments.
