export type IncidentSeverity = 'critical' | 'error' | 'warning' | 'info';
export type IncidentAction = 'diagnose' | 'mitigate' | 'verify' | 'escalate';

export interface IncidentSignal {
  id: string;
  service: string;
  summary: string;
  severity: IncidentSeverity;
  source: string;
  metric?: string;
  value?: number;
  labels?: Record<string, string>;
  occurredAt?: Date;
}

export interface RunbookStep {
  id: string;
  action: IncidentAction;
  description: string;
  command?: string;
  dashboard?: string;
  timeoutSeconds: number;
}

export interface RunbookDefinition {
  id: string;
  service: string;
  title: string;
  pagerDutyServiceKeyEnv: string;
  escalationPolicy: string;
  dashboardUrl: string;
  steps: RunbookStep[];
}

export interface RunbookExecution {
  id: string;
  signal: IncidentSignal;
  runbook: RunbookDefinition;
  status: 'opened' | 'suppressed' | 'failed';
  pagerDutyDedupKey: string;
  pagerDutyIncidentKey?: string;
  nextSteps: RunbookStep[];
  createdAt: string;
}
