import { IncidentSignal, RunbookDefinition } from './types';

export interface PagerDutyTriggerResult { dedupKey: string; incidentKey?: string; status: string; }
export interface PagerDutyClientOptions { routingKey: string; endpoint?: string; fetchImpl?: typeof fetch; }

export class PagerDutyEventsClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PagerDutyClientOptions) {
    this.endpoint = options.endpoint ?? 'https://events.pagerduty.com/v2/enqueue';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async trigger(signal: IncidentSignal, runbook: RunbookDefinition, dedupKey: string): Promise<PagerDutyTriggerResult> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        routing_key: this.options.routingKey,
        event_action: 'trigger',
        dedup_key: dedupKey,
        payload: {
          summary: signal.summary,
          source: signal.source,
          severity: signal.severity,
          component: signal.service,
          class: runbook.id,
          custom_details: {
            runbook: runbook.title,
            runbook_id: runbook.id,
            dashboard_url: runbook.dashboardUrl,
            escalation_policy: runbook.escalationPolicy,
            metric: signal.metric,
            value: signal.value,
            labels: signal.labels ?? {},
            next_steps: runbook.steps.map((step) => step.description),
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`PagerDuty enqueue failed with HTTP ${response.status}`);
    const body = await response.json() as { dedup_key?: string; incident_key?: string; status?: string };
    return { dedupKey: body.dedup_key ?? dedupKey, incidentKey: body.incident_key, status: body.status ?? 'success' };
  }
}
