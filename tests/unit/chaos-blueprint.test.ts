import { describe, expect, it } from 'vitest';
import { stagingChaosBlueprint, validateChaosBlueprint, ChaosTestingBlueprint } from '../../src/chaos/staging-blueprint';

describe('staging chaos testing blueprint', () => {
  it('meets staging reliability, performance, and security guardrails', () => {
    expect(validateChaosBlueprint(stagingChaosBlueprint)).toEqual([]);
    expect(stagingChaosBlueprint.performanceP99Ms).toBeLessThanOrEqual(100);
    expect(stagingChaosBlueprint.availabilityTarget).toBeGreaterThanOrEqual(0.9999);
    expect(stagingChaosBlueprint.requiredSecurityReview).toBe(true);
  });

  it('requires abort conditions and operational runbooks for every experiment', () => {
    for (const experiment of stagingChaosBlueprint.experiments) {
      expect(experiment.abortConditions.length).toBeGreaterThan(0);
      expect(experiment.runbook).toMatch(/^docs\/operations\/chaos-engineering-staging\.md#/);
    }
  });

  it('reports missing mandatory guardrails', () => {
    const invalid: ChaosTestingBlueprint = {
      ...stagingChaosBlueprint,
      performanceP99Ms: 125,
      availabilityTarget: 0.99,
      requiredSecurityReview: false,
      steadyStateObjectives: [],
      experiments: [{ ...stagingChaosBlueprint.experiments[0], abortConditions: [], durationMinutes: 0, runbook: 'BACKEND.md' }],
    };

    expect(validateChaosBlueprint(invalid)).toEqual(expect.arrayContaining([
      'Critical path P99 target must be 100ms or lower.',
      'Availability target must be at least 99.99%.',
      'Security review is required before chaos execution.',
      'Missing critical-path P99 steady-state objective.',
      'Missing availability steady-state objective.',
      'Missing security steady-state objective.',
      'api-latency-injection must have a positive duration.',
      'api-latency-injection must define abort conditions.',
      'api-latency-injection must link to an operations runbook.',
    ]));
  });
});
