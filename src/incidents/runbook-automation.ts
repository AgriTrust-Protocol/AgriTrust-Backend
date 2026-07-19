import { createHash, randomUUID } from 'crypto';
import { PagerDutyEventsClient } from './pagerduty-client';
import { incidentPagerDutyTriggerDurationMs, incidentRunbookExecutionsTotal } from './metrics';
import { RunbookRegistry } from './runbook-registry';
import { IncidentSignal, RunbookExecution } from './types';

export interface RunbookAutomationOptions {
  registry?: RunbookRegistry;
  pagerDutyClientFactory?: (routingKey: string) => Pick<PagerDutyEventsClient, 'trigger'>;
  dedupWindowMs?: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export class IncidentRunbookAutomation {
  private readonly registry: RunbookRegistry;
  private readonly dedupWindowMs: number;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly recent = new Map<string, number>();

  constructor(private readonly options: RunbookAutomationOptions = {}) {
    this.registry = options.registry ?? new RunbookRegistry();
    this.dedupWindowMs = options.dedupWindowMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
  }

  async handle(signal: IncidentSignal): Promise<RunbookExecution> {
    const runbook = this.registry.match(signal);
    const dedupKey = this.dedupKey(signal, runbook.id);
    const lastSeen = this.recent.get(dedupKey);
    if (lastSeen && this.now() - lastSeen < this.dedupWindowMs) {
      incidentRunbookExecutionsTotal.inc({ runbook_id: runbook.id, service: signal.service, status: 'suppressed' });
      return { id: randomUUID(), signal, runbook, status: 'suppressed', pagerDutyDedupKey: dedupKey, nextSteps: runbook.steps, createdAt: new Date(this.now()).toISOString() };
    }

    const routingKey = this.env[runbook.pagerDutyServiceKeyEnv];
    if (!routingKey) {
      incidentRunbookExecutionsTotal.inc({ runbook_id: runbook.id, service: signal.service, status: 'failed' });
      throw new Error(`Missing PagerDuty routing key env var ${runbook.pagerDutyServiceKeyEnv}`);
    }

    const endTimer = incidentPagerDutyTriggerDurationMs.startTimer({ runbook_id: runbook.id, service: signal.service });
    try {
      const client = this.options.pagerDutyClientFactory?.(routingKey) ?? new PagerDutyEventsClient({ routingKey });
      const result = await client.trigger(signal, runbook, dedupKey);
      this.recent.set(dedupKey, this.now());
      incidentRunbookExecutionsTotal.inc({ runbook_id: runbook.id, service: signal.service, status: 'opened' });
      return { id: randomUUID(), signal, runbook, status: 'opened', pagerDutyDedupKey: result.dedupKey, pagerDutyIncidentKey: result.incidentKey, nextSteps: runbook.steps, createdAt: new Date(this.now()).toISOString() };
    } finally {
      endTimer();
    }
  }

  private dedupKey(signal: IncidentSignal, runbookId: string): string {
    return createHash('sha256').update([runbookId, signal.service, signal.metric ?? signal.summary, signal.labels?.route ?? '', signal.labels?.tenant_id ?? ''].join('|')).digest('hex').slice(0, 32);
  }
}
