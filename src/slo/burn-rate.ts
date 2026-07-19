export interface SloObjective {
  name: string;
  target: number;
  windowHours: number;
}

export interface BurnRateWindow {
  label: string;
  durationHours: number;
  totalEvents: number;
  badEvents: number;
}

export interface BurnRateEvaluation {
  objective: SloObjective;
  window: BurnRateWindow;
  errorBudget: number;
  observedErrorRatio: number;
  burnRate: number;
  projectedBudgetHoursRemaining: number | null;
}

export interface MultiWindowBurnRatePolicy {
  pageFastBurnThreshold: number;
  pageSlowBurnThreshold: number;
  ticketBurnThreshold: number;
}

export interface MultiWindowBurnRateEvaluation {
  evaluations: BurnRateEvaluation[];
  severity: 'ok' | 'ticket' | 'page';
  reasons: string[];
}

export const AVAILABILITY_99_99: SloObjective = {
  name: 'system_availability',
  target: 0.9999,
  windowHours: 30 * 24,
};

export const DEFAULT_BURN_RATE_POLICY: MultiWindowBurnRatePolicy = {
  pageFastBurnThreshold: 14.4,
  pageSlowBurnThreshold: 6,
  ticketBurnThreshold: 3,
};

export function evaluateBurnRate(
  objective: SloObjective,
  window: BurnRateWindow,
): BurnRateEvaluation {
  const errorBudget = 1 - objective.target;
  if (errorBudget <= 0 || errorBudget >= 1) {
    throw new Error(`SLO target for ${objective.name} must be between 0 and 1 exclusive`);
  }

  if (window.totalEvents < 0 || window.badEvents < 0) {
    throw new Error('totalEvents and badEvents must be non-negative');
  }

  if (window.badEvents > window.totalEvents) {
    throw new Error('badEvents cannot exceed totalEvents');
  }

  const observedErrorRatio = window.totalEvents === 0 ? 0 : window.badEvents / window.totalEvents;
  const burnRate = observedErrorRatio / errorBudget;
  const projectedBudgetHoursRemaining = burnRate === 0 ? null : objective.windowHours / burnRate;

  return {
    objective,
    window,
    errorBudget,
    observedErrorRatio,
    burnRate,
    projectedBudgetHoursRemaining,
  };
}

export function evaluateMultiWindowBurnRate(
  objective: SloObjective,
  windows: BurnRateWindow[],
  policy: MultiWindowBurnRatePolicy = DEFAULT_BURN_RATE_POLICY,
): MultiWindowBurnRateEvaluation {
  const evaluations = windows.map((window) => evaluateBurnRate(objective, window));
  const byLabel = new Map(evaluations.map((evaluation) => [evaluation.window.label, evaluation]));
  const reasons: string[] = [];

  const fastShort = byLabel.get('5m');
  const fastLong = byLabel.get('1h');
  const slowShort = byLabel.get('30m');
  const slowLong = byLabel.get('6h');
  const ticketShort = byLabel.get('2h');
  const ticketLong = byLabel.get('24h');

  if (fastShort && fastLong && fastShort.burnRate >= policy.pageFastBurnThreshold && fastLong.burnRate >= policy.pageFastBurnThreshold) {
    reasons.push(`fast burn page: 5m and 1h burn rates are at least ${policy.pageFastBurnThreshold}x`);
  }

  if (slowShort && slowLong && slowShort.burnRate >= policy.pageSlowBurnThreshold && slowLong.burnRate >= policy.pageSlowBurnThreshold) {
    reasons.push(`slow burn page: 30m and 6h burn rates are at least ${policy.pageSlowBurnThreshold}x`);
  }

  if (reasons.length > 0) {
    return { evaluations, severity: 'page', reasons };
  }

  if (ticketShort && ticketLong && ticketShort.burnRate >= policy.ticketBurnThreshold && ticketLong.burnRate >= policy.ticketBurnThreshold) {
    reasons.push(`ticket: 2h and 24h burn rates are at least ${policy.ticketBurnThreshold}x`);
    return { evaluations, severity: 'ticket', reasons };
  }

  return { evaluations, severity: 'ok', reasons };
}
