export interface PerformanceSample {
  route: string;
  p99Ms: number;
  errorRate: number;
  availability: number;
  sampleCount: number;
}

export interface PerformanceBudget {
  maxP99Ms: number;
  minAvailability: number;
  maxErrorRate: number;
  minSampleCount: number;
}

export interface RegressionResult {
  passed: boolean;
  violations: string[];
}

export const CRITICAL_PATH_BUDGET: PerformanceBudget = {
  maxP99Ms: 100,
  minAvailability: 0.9999,
  maxErrorRate: 0.0001,
  minSampleCount: 25,
};

export function evaluatePerformanceSample(
  sample: PerformanceSample,
  budget: PerformanceBudget = CRITICAL_PATH_BUDGET,
): RegressionResult {
  const violations: string[] = [];

  if (sample.sampleCount < budget.minSampleCount) {
    violations.push(
      `${sample.route} collected ${sample.sampleCount} samples; requires ${budget.minSampleCount}`,
    );
  }

  if (sample.p99Ms > budget.maxP99Ms) {
    violations.push(`${sample.route} P99 ${sample.p99Ms}ms exceeds ${budget.maxP99Ms}ms budget`);
  }

  if (sample.availability < budget.minAvailability) {
    violations.push(
      `${sample.route} availability ${sample.availability} is below ${budget.minAvailability}`,
    );
  }

  if (sample.errorRate > budget.maxErrorRate) {
    violations.push(
      `${sample.route} error rate ${sample.errorRate} exceeds ${budget.maxErrorRate}`,
    );
  }

  return { passed: violations.length === 0, violations };
}

export function evaluatePerformanceSuite(samples: PerformanceSample[]): RegressionResult {
  const violations = samples.flatMap((sample) => evaluatePerformanceSample(sample).violations);
  return { passed: violations.length === 0, violations };
}
