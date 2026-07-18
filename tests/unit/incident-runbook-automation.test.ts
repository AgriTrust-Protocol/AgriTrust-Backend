import { describe, expect, it, vi } from 'vitest';
import { IncidentRunbookAutomation } from '../../src/incidents/runbook-automation';
import { IncidentSignal } from '../../src/incidents/types';

const latencySignal: IncidentSignal = {
  id: 'alert-1',
  service: 'api-gateway',
  summary: 'Critical path P99 latency above 100ms',
  severity: 'critical',
  source: 'prometheus',
  metric: 'http_request_duration_p99_ms',
  value: 137,
  labels: { route: '/api/v1/batches/:id/certify' },
};

describe('IncidentRunbookAutomation', () => {
  it('matches latency signals to the critical-path runbook and triggers PagerDuty', async () => {
    const trigger = vi.fn().mockResolvedValue({ dedupKey: 'pd-dedup', incidentKey: 'P123', status: 'success' });
    const automation = new IncidentRunbookAutomation({
      env: { PAGERDUTY_API_GATEWAY_ROUTING_KEY: 'routing-key' },
      pagerDutyClientFactory: (routingKey) => {
        expect(routingKey).toBe('routing-key');
        return { trigger };
      },
      now: () => new Date('2026-07-18T00:00:00Z').getTime(),
    });

    const execution = await automation.handle(latencySignal);

    expect(execution.status).toBe('opened');
    expect(execution.runbook.id).toBe('critical-path-latency');
    expect(execution.pagerDutyIncidentKey).toBe('P123');
    expect(execution.nextSteps.map((step) => step.action)).toContain('mitigate');
    expect(trigger).toHaveBeenCalledOnce();
  });

  it('suppresses duplicate alerts inside the deduplication window', async () => {
    let now = new Date('2026-07-18T00:00:00Z').getTime();
    const trigger = vi.fn().mockResolvedValue({ dedupKey: 'pd-dedup', status: 'success' });
    const automation = new IncidentRunbookAutomation({
      env: { PAGERDUTY_API_GATEWAY_ROUTING_KEY: 'routing-key' },
      pagerDutyClientFactory: () => ({ trigger }),
      dedupWindowMs: 60_000,
      now: () => now,
    });

    await automation.handle(latencySignal);
    now += 30_000;
    const duplicate = await automation.handle({ ...latencySignal, id: 'alert-2' });

    expect(duplicate.status).toBe('suppressed');
    expect(trigger).toHaveBeenCalledOnce();
  });

  it('fails closed when the PagerDuty routing key is not configured', async () => {
    const automation = new IncidentRunbookAutomation({ env: {} });

    await expect(automation.handle(latencySignal)).rejects.toThrow('Missing PagerDuty routing key env var PAGERDUTY_API_GATEWAY_ROUTING_KEY');
  });
});
