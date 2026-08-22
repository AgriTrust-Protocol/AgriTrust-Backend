import { bootstrapConfidenceInterval, ConfidenceInterval } from './bootstrap';
import { DEFAULT_TRUST_SCORE } from './trust_score';
import { NormalizedYieldReport } from './ingestion';

export interface ConsensusOptions {
  trustScores?: Map<string, number> | Record<string, number>;
  historicalAverage?: number;
  bootstrapResamples?: number;
  random?: () => number;
}

export interface ConsensusResult {
  yieldEstimate: number;
  confidenceInterval: ConfidenceInterval;
  sourceCount: number;
  rejectedSourceIds: string[];
  trustScores: Record<string, number>;
  penaltyFlag: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function trustFor(
  sourceId: string,
  trustScores?: Map<string, number> | Record<string, number>,
): number {
  const score = trustScores instanceof Map ? trustScores.get(sourceId) : trustScores?.[sourceId];
  return Number.isFinite(score) && score! > 0 ? score! : DEFAULT_TRUST_SCORE;
}

export function rejectOutliersByModifiedZScore(
  reports: NormalizedYieldReport[],
  threshold = 3.5,
): {
  accepted: NormalizedYieldReport[];
  rejected: NormalizedYieldReport[];
} {
  if (reports.length < 3) return { accepted: reports, rejected: [] };
  const values = reports.map((report) => report.value);
  const med = median(values);
  const absoluteDeviations = values.map((value) => Math.abs(value - med));
  const mad = median(absoluteDeviations);
  if (mad === 0) {
    return { accepted: reports, rejected: [] };
  }

  const accepted: NormalizedYieldReport[] = [];
  const rejected: NormalizedYieldReport[] = [];
  for (const report of reports) {
    const modifiedZ = (0.6745 * (report.value - med)) / mad;
    if (Math.abs(modifiedZ) > threshold) rejected.push(report);
    else accepted.push(report);
  }
  return { accepted, rejected };
}

export function computeWeightedConsensus(
  reports: NormalizedYieldReport[],
  options: ConsensusOptions = {},
): ConsensusResult {
  if (reports.length === 0 && options.historicalAverage === undefined) {
    throw new Error('At least one yield report or a historical average is required');
  }

  const { accepted, rejected } = rejectOutliersByModifiedZScore(reports);
  const usable = accepted.length >= 2 ? accepted : [];
  const penaltyFlag = usable.length < 2;

  if (penaltyFlag) {
    if (options.historicalAverage === undefined) {
      throw new Error('Historical average is required when fewer than 2 sources remain');
    }
    return {
      yieldEstimate: options.historicalAverage,
      confidenceInterval: { lower: options.historicalAverage, upper: options.historicalAverage },
      sourceCount: usable.length,
      rejectedSourceIds: rejected.map((report) => report.sourceId),
      trustScores: {},
      penaltyFlag: true,
    };
  }

  const values = usable.map((report) => report.value);
  const weights = usable.map((report) => trustFor(report.sourceId, options.trustScores));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const yieldEstimate =
    values.reduce((sum, value, index) => sum + value * weights[index], 0) / weightSum;
  const ci = bootstrapConfidenceInterval(values, weights, {
    resamples: options.bootstrapResamples ?? 10_000,
    random: options.random,
  });

  return {
    yieldEstimate,
    confidenceInterval: ci,
    sourceCount: usable.length,
    rejectedSourceIds: rejected.map((report) => report.sourceId),
    trustScores: Object.fromEntries(
      usable.map((report, index) => [report.sourceId, weights[index]]),
    ),
    penaltyFlag: false,
  };
}
