import { describe, expect, it } from 'vitest';
import {
  evaluatePerformanceSample,
  evaluatePerformanceSuite,
} from '../../src/performance/regression';

describe('performance regression detection', () => {
  it('passes critical paths under the 100ms P99 and 99.99% availability budgets', () => {
    const result = evaluatePerformanceSample({
      route: '/',
      p99Ms: 42,
      errorRate: 0,
      availability: 1,
      sampleCount: 100,
    });

    expect(result).toEqual({ passed: true, violations: [] });
  });

  it('fails samples that exceed latency, availability, error, or sample-count budgets', () => {
    const result = evaluatePerformanceSample({
      route: '/api/v1/batches',
      p99Ms: 125,
      errorRate: 0.02,
      availability: 0.99,
      sampleCount: 10,
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(4);
    expect(result.violations.join('\n')).toContain('P99 125ms exceeds 100ms budget');
  });

  it('aggregates suite violations across all critical paths', () => {
    const result = evaluatePerformanceSuite([
      { route: '/', p99Ms: 50, errorRate: 0, availability: 1, sampleCount: 50 },
      { route: '/metrics', p99Ms: 150, errorRate: 0, availability: 1, sampleCount: 50 },
    ]);

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(['/metrics P99 150ms exceeds 100ms budget']);
  });
});
