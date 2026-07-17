export type ChaosExperimentType =
  | 'latency'
  | 'error-rate'
  | 'pod-kill'
  | 'network-partition'
  | 'dependency-timeout';

export interface ChaosSteadyStateObjective {
  name: string;
  query: string;
  threshold: string;
  target: 'critical-path-p99' | 'availability' | 'error-budget' | 'security';
}

export interface ChaosExperiment {
  id: string;
  service: string;
  type: ChaosExperimentType;
  hypothesis: string;
  blastRadius: 'single-pod' | 'single-az' | 'single-dependency';
  durationMinutes: number;
  abortConditions: string[];
  runbook: string;
}

export interface ChaosStageGate {
  stage: 'design' | 'preflight' | 'canary' | 'blue-green' | 'review';
  requiredEvidence: string[];
}

export interface ChaosTestingBlueprint {
  environment: 'staging';
  performanceP99Ms: number;
  availabilityTarget: number;
  steadyStateObjectives: ChaosSteadyStateObjective[];
  experiments: ChaosExperiment[];
  stageGates: ChaosStageGate[];
  requiredSecurityReview: boolean;
}

export const stagingChaosBlueprint: ChaosTestingBlueprint = {
  environment: 'staging',
  performanceP99Ms: 100,
  availabilityTarget: 0.9999,
  requiredSecurityReview: true,
  steadyStateObjectives: [
    {
      name: 'Critical API P99 latency remains below 100ms',
      query: 'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{route=~"/api/(certifications|ingestion|sensors).*"}[5m])) by (le, route))',
      threshold: '< 0.100',
      target: 'critical-path-p99',
    },
    {
      name: 'Staging availability remains at or above 99.99%',
      query: 'sum(rate(http_requests_total{status!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))',
      threshold: '>= 0.9999',
      target: 'availability',
    },
    {
      name: 'No chaos test bypasses authentication or tenant isolation',
      query: 'sum(increase(security_policy_violation_total[5m]))',
      threshold: '== 0',
      target: 'security',
    },
  ],
  experiments: [
    {
      id: 'api-latency-injection',
      service: 'api',
      type: 'latency',
      hypothesis: 'API retries, timeouts, and dashboards expose latency while critical paths stay below 100ms P99.',
      blastRadius: 'single-pod',
      durationMinutes: 10,
      abortConditions: ['critical_path_p99_ms >= 100 for 2 consecutive minutes', '5xx_rate >= 1%', 'security_policy_violation_total > 0'],
      runbook: 'docs/operations/chaos-engineering-staging.md#api-latency-injection',
    },
    {
      id: 'soroban-rpc-dependency-timeout',
      service: 'soroban-rpc',
      type: 'dependency-timeout',
      hypothesis: 'Circuit breakers and the RPC load balancer fail over without exhausting the error budget.',
      blastRadius: 'single-dependency',
      durationMinutes: 15,
      abortConditions: ['rpc_error_rate >= 2%', 'circuit_breaker_open_total increases without recovery for 5 minutes'],
      runbook: 'docs/operations/chaos-engineering-staging.md#soroban-rpc-dependency-timeout',
    },
  ],
  stageGates: [
    { stage: 'design', requiredEvidence: ['architecture diagram reviewed', 'experiment blast radius approved'] },
    { stage: 'preflight', requiredEvidence: ['security review complete', 'staging backup verified', 'rollback owner assigned'] },
    { stage: 'canary', requiredEvidence: ['10% traffic analysis clean', 'alerts routed to on-call'] },
    { stage: 'blue-green', requiredEvidence: ['green environment healthy', 'blue rollback tested'] },
    { stage: 'review', requiredEvidence: ['findings recorded', 'runbook updates merged'] },
  ],
};

export function validateChaosBlueprint(blueprint: ChaosTestingBlueprint): string[] {
  const errors: string[] = [];
  if (blueprint.environment !== 'staging') errors.push('Chaos blueprint must target staging.');
  if (blueprint.performanceP99Ms > 100) errors.push('Critical path P99 target must be 100ms or lower.');
  if (blueprint.availabilityTarget < 0.9999) errors.push('Availability target must be at least 99.99%.');
  if (!blueprint.requiredSecurityReview) errors.push('Security review is required before chaos execution.');
  if (!blueprint.steadyStateObjectives.some((objective) => objective.target === 'critical-path-p99')) errors.push('Missing critical-path P99 steady-state objective.');
  if (!blueprint.steadyStateObjectives.some((objective) => objective.target === 'availability')) errors.push('Missing availability steady-state objective.');
  if (!blueprint.steadyStateObjectives.some((objective) => objective.target === 'security')) errors.push('Missing security steady-state objective.');
  for (const experiment of blueprint.experiments) {
    if (experiment.durationMinutes <= 0) errors.push(`${experiment.id} must have a positive duration.`);
    if (experiment.blastRadius !== 'single-pod' && experiment.blastRadius !== 'single-az' && experiment.blastRadius !== 'single-dependency') errors.push(`${experiment.id} has an unsupported blast radius.`);
    if (experiment.abortConditions.length === 0) errors.push(`${experiment.id} must define abort conditions.`);
    if (!experiment.runbook.startsWith('docs/operations/')) errors.push(`${experiment.id} must link to an operations runbook.`);
  }
  return errors;
}
