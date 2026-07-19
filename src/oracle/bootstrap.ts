export interface BootstrapOptions {
  resamples?: number;
  confidenceLevel?: number;
  random?: () => number;
}

export interface ConfidenceInterval {
  lower: number;
  upper: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function bootstrapConfidenceInterval(
  values: number[],
  weights: number[],
  options: BootstrapOptions = {},
): ConfidenceInterval {
  if (values.length !== weights.length || values.length === 0) {
    throw new Error('Bootstrap values and weights must be non-empty arrays of the same length');
  }

  const resamples = options.resamples ?? 10_000;
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const random = options.random ?? Math.random;
  const estimates: number[] = [];

  for (let i = 0; i < resamples; i++) {
    let weightedSum = 0;
    let weightSum = 0;
    for (let j = 0; j < values.length; j++) {
      const picked = Math.floor(random() * values.length);
      weightedSum += values[picked] * weights[picked];
      weightSum += weights[picked];
    }
    estimates.push(weightedSum / weightSum);
  }

  estimates.sort((a, b) => a - b);
  const alpha = 1 - confidenceLevel;
  return {
    lower: percentile(estimates, alpha / 2),
    upper: percentile(estimates, 1 - alpha / 2),
  };
}
