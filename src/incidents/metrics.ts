import { Counter, Histogram } from 'prom-client';

export const incidentRunbookExecutionsTotal = new Counter({
  name: 'incident_runbook_executions_total',
  help: 'Incident runbook automation executions by runbook, service, and status.',
  labelNames: ['runbook_id', 'service', 'status'],
});

export const incidentPagerDutyTriggerDurationMs = new Histogram({
  name: 'incident_pagerduty_trigger_duration_ms',
  help: 'PagerDuty Events API trigger latency in milliseconds.',
  labelNames: ['runbook_id', 'service'],
  buckets: [10, 25, 50, 75, 100, 250, 500, 1000, 2500],
});
