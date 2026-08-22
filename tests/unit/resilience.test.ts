import { describe, expect, it } from 'vitest';
import { CapacityShedder, classifyRequest } from '../../src/resilience/capacity-shedder';
import { FeatureFlagRegistry, parseFeatureFlagState } from '../../src/resilience/feature-flags';

describe('FeatureFlagRegistry', () => {
  it('evaluates defaults, environment values, and overrides', () => {
    const registry = new FeatureFlagRegistry([
      { name: 'demo.flag', description: 'demo', defaultState: 'disabled' },
    ]);

    expect(registry.evaluate('demo.flag', {}).enabled).toBe(false);
    expect(registry.evaluate('demo.flag', { FEATURE_DEMO_FLAG: 'true' }).enabled).toBe(true);

    registry.setOverride('demo.flag', 'shadow');
    expect(registry.evaluate('demo.flag', { FEATURE_DEMO_FLAG: 'true' })).toMatchObject({
      enabled: false,
      state: 'shadow',
      source: 'override',
    });
  });

  it('parses common flag values', () => {
    expect(parseFeatureFlagState('enabled')).toBe('enabled');
    expect(parseFeatureFlagState('OFF')).toBe('disabled');
    expect(parseFeatureFlagState('shadow')).toBe('shadow');
    expect(parseFeatureFlagState('maybe')).toBeUndefined();
  });
});

describe('CapacityShedder', () => {
  const shedder = new CapacityShedder({
    maxInflight: 100,
    maxEventLoopLagMs: 100,
    maxCpuUtilization: 1,
    maxMemoryUtilization: 1,
    shedBackgroundAt: 0.7,
    shedImportantAt: 0.9,
  });

  it('protects critical paths during saturation', () => {
    const decision = shedder.decide('critical', {
      inflight: 100,
      eventLoopLagMs: 100,
      cpuUtilization: 1,
      memoryUtilization: 1,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
    expect(decision.reason).toBe('critical-path-protected');
  });

  it('sheds background traffic before important traffic', () => {
    const signal = { inflight: 75, eventLoopLagMs: 0, cpuUtilization: 0, memoryUtilization: 0 };

    expect(shedder.decide('background', signal)).toMatchObject({
      allowed: false,
      reason: 'background-capacity-shed',
    });
    expect(shedder.decide('important', signal)).toMatchObject({ allowed: true, degraded: true });
  });

  it('sheds important traffic only at the higher threshold', () => {
    const signal = { inflight: 95, eventLoopLagMs: 0, cpuUtilization: 0, memoryUtilization: 0 };

    expect(shedder.decide('important', signal)).toMatchObject({
      allowed: false,
      reason: 'important-capacity-shed',
    });
  });
});

describe('classifyRequest', () => {
  it('classifies health and metrics as critical', () => {
    expect(classifyRequest({ method: 'GET', path: '/health' })).toBe('critical');
    expect(classifyRequest({ method: 'GET', path: '/metrics' })).toBe('critical');
  });

  it('classifies webhook routes as background', () => {
    expect(classifyRequest({ method: 'POST', path: '/api/admin/webhooks/retry' })).toBe(
      'background',
    );
  });
});
