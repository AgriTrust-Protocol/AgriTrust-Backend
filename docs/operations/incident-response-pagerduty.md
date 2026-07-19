# Incident response runbook automation with PagerDuty

## Architecture

`IncidentRunbookAutomation` receives normalized Prometheus, health, or webhook signals, selects a runbook from `RunbookRegistry`, and triggers PagerDuty Events API v2 with a stable deduplication key. The PagerDuty payload includes the dashboard, escalation policy, metric context, labels, and ordered mitigation steps so responders can start from the incident timeline.

## PagerDuty configuration

Configure routing keys per service:

- `PAGERDUTY_API_GATEWAY_ROUTING_KEY` for critical API latency.
- `PAGERDUTY_PLATFORM_ROUTING_KEY` for system availability burn.
- `PAGERDUTY_WEBHOOKS_ROUTING_KEY` for webhook dead letters.

Missing routing keys fail closed and increment `incident_runbook_executions_total{status="failed"}`.

## Monitoring and alerting

Import `monitoring/alerts/incident-runbook-automation.yaml` into Prometheus and `monitoring/dashboards/incident-runbook-automation.json` into Grafana. The critical PagerDuty trigger path is measured by `incident_pagerduty_trigger_duration_ms` and must remain below 100ms P99. Runbook state is counted in `incident_runbook_executions_total{runbook_id,service,status}`.

## Deployment

Use the existing blue-green flow: deploy to green, mirror alert traffic, run a canary with synthetic latency and availability signals, and promote only when PagerDuty events deduplicate correctly and automation latency remains below 100ms P99. Roll back to blue if duplicate pages, missing runbook metadata, or failed PagerDuty triggers appear.

## Automation failure

1. Check `incident_runbook_executions_total{status="failed"}` by service.
2. Verify the service-specific PagerDuty routing key is present in the runtime secret injector.
3. Replay the source alert after the key is fixed.
4. Open a security review if the failed payload contained unexpected labels or secrets.

## PagerDuty latency

1. Compare `incident_pagerduty_trigger_duration_ms` with outbound network and DNS metrics.
2. If PagerDuty is degraded, manually page the escalation policy and keep automation in observation mode.
3. Re-enable automatic paging after two clean five-minute windows below 100ms P99.
