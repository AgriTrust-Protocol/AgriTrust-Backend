/**
 * Deterministic sample decision for a trace-id at an explicit probability.
 * The same trace-id + probability always yields the same decision, so a trace
 * is sampled (or not) consistently across every hop.
 */
export function sampleTraceId(traceId: string, probability: number): boolean {
  const p = Math.max(0, Math.min(1, probability));
  if (p >= 1) return true;
  if (p <= 0) return false;
  if (!traceId || traceId.length < 2) {
    return Math.random() < p;
  }
  // Use the first byte (first 2 hex chars) for a deterministic decision.
  const firstByte = parseInt(traceId.substring(0, 2), 16);
  return firstByte <= p * 255;
}

/**
 * Route-based sampling probability (issue #177):
 * - 100% for financial settlement routes — a settlement trace is never dropped.
 * - 1% for read-only (GET) queries — high-volume, low individual value.
 * - the configured default for everything else (writes, RPC, etc.).
 */
export function resolveSamplingProbability(
  method: string,
  path: string,
  defaultProbability: number,
): number {
  if (/^\/api\/settlements(\/|$)/.test(path)) return 1;
  if (method.toUpperCase() === 'GET') return 0.01;
  return defaultProbability;
}

export class DeterministicSampler {
  private readonly probability: number;

  constructor(probability: number = 0.8) {
    this.probability = Math.max(0, Math.min(1, probability));
  }

  shouldSample(traceId: string): boolean {
    return sampleTraceId(traceId, this.probability);
  }

  getProbability(): number {
    return this.probability;
  }
}
