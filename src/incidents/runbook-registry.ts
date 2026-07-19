import { IncidentSignal, RunbookDefinition } from './types';

export const DEFAULT_RUNBOOKS: RunbookDefinition[] = [
  {
    id: 'critical-path-latency',
    service: 'api-gateway',
    title: 'Critical path P99 latency above 100ms',
    pagerDutyServiceKeyEnv: 'PAGERDUTY_API_GATEWAY_ROUTING_KEY',
    escalationPolicy: 'primary-on-call',
    dashboardUrl: '/d/incident-runbook-automation/agritrust-incident-runbook-automation?var-service=api-gateway',
    steps: [
      { id: 'latency-diagnose', action: 'diagnose', description: 'Compare p99 latency, request volume, and dependency errors for the affected route.', dashboard: 'critical-path-latency', timeoutSeconds: 120 },
      { id: 'shed-background', action: 'mitigate', description: 'Enable background traffic shedding if capacity pressure is high.', command: 'POST /health/resilience/actions/shed-background', timeoutSeconds: 180 },
      { id: 'canary-rollback', action: 'mitigate', description: 'Rollback the active canary when the regression is isolated to a new version.', command: 'POST /admin/experiments/:id/rollback', timeoutSeconds: 300 },
      { id: 'verify-slo', action: 'verify', description: 'Verify critical-path p99 is below 100ms for two consecutive windows.', dashboard: 'critical-path-latency', timeoutSeconds: 600 },
    ],
  },
  {
    id: 'availability-budget-burn',
    service: 'system',
    title: '99.99% availability budget burn',
    pagerDutyServiceKeyEnv: 'PAGERDUTY_PLATFORM_ROUTING_KEY',
    escalationPolicy: 'incident-commander',
    dashboardUrl: '/d/incident-runbook-automation/agritrust-incident-runbook-automation?var-service=system',
    steps: [
      { id: 'declare-incident', action: 'escalate', description: 'Declare a SEV and assign incident commander, communications lead, and service owners.', timeoutSeconds: 300 },
      { id: 'dependency-triage', action: 'diagnose', description: 'Check health aggregation, cascading dependency alerts, and recent deploys.', dashboard: 'availability', timeoutSeconds: 180 },
      { id: 'blue-green-shift', action: 'mitigate', description: 'Shift traffic to the known-good blue/green pool if canary analysis fails.', command: 'progressive-delivery shift --target stable', timeoutSeconds: 300 },
      { id: 'verify-availability', action: 'verify', description: 'Verify 5xx rate and synthetic availability meet the 99.99% objective.', dashboard: 'availability', timeoutSeconds: 600 },
    ],
  },
  {
    id: 'webhook-dead-letters',
    service: 'webhooks',
    title: 'Webhook dead letters detected',
    pagerDutyServiceKeyEnv: 'PAGERDUTY_WEBHOOKS_ROUTING_KEY',
    escalationPolicy: 'integrations-on-call',
    dashboardUrl: '/d/incident-runbook-automation/agritrust-incident-runbook-automation?var-service=webhooks',
    steps: [
      { id: 'inspect-dlq', action: 'diagnose', description: 'Inspect dead-letter payloads and receiver response codes.', command: 'GET /api/admin/webhooks/dead-letter', timeoutSeconds: 120 },
      { id: 'pause-retries', action: 'mitigate', description: 'Pause noisy subscriptions or retry only fixed receivers.', command: 'POST /api/admin/webhooks/dead-letter/:id/replay', timeoutSeconds: 300 },
      { id: 'verify-delivery', action: 'verify', description: 'Confirm retry success and queue depth recovery.', dashboard: 'webhook-delivery', timeoutSeconds: 600 },
    ],
  },
];

export class RunbookRegistry {
  constructor(private readonly runbooks: RunbookDefinition[] = DEFAULT_RUNBOOKS) {}

  match(signal: IncidentSignal): RunbookDefinition {
    const metric = signal.metric?.toLowerCase() ?? '';
    const service = signal.service.toLowerCase();
    if (metric.includes('latency') || signal.summary.toLowerCase().includes('p99')) return this.byId('critical-path-latency');
    if (metric.includes('availability') || metric.includes('5xx') || signal.summary.toLowerCase().includes('budget')) return this.byId('availability-budget-burn');
    if (service.includes('webhook') || metric.includes('webhook')) return this.byId('webhook-dead-letters');
    return this.byId('availability-budget-burn');
  }

  byId(id: string): RunbookDefinition {
    const runbook = this.runbooks.find((candidate) => candidate.id === id);
    if (!runbook) throw new Error(`Runbook not found: ${id}`);
    return runbook;
  }

  list(): RunbookDefinition[] { return [...this.runbooks]; }
}
