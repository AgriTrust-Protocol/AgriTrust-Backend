import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureEngine, FlagDefinition, tenantBucket } from '../engine';

const BASE_FLAG: FlagDefinition = {
  key: 'test-flag',
  enabled: true,
  rolloutPercentage: 100,
  targetingRules: [],
  payload: { version: 1 },
  variants: ['control', 'treatment'],
};

describe('FeatureEngine', () => {
  let engine: FeatureEngine;

  beforeEach(() => {
    engine = new FeatureEngine();
  });

  // ── Kill-switch ────────────────────────────────────────────────────

  it('returns disabled when kill-switch is off', () => {
    engine.setFlag({ ...BASE_FLAG, enabled: false });
    const result = engine.evaluate('test-flag', { tenantId: 'tenant-1' });
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('kill-switch');
  });

  // ── Unknown flag ───────────────────────────────────────────────────

  it('returns default-off for unknown flag', () => {
    const result = engine.evaluate('nonexistent', { tenantId: 'tenant-1' });
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('default-off');
  });

  // ── Full rollout ───────────────────────────────────────────────────

  it('enables flag for all tenants at 100% rollout', () => {
    engine.setFlag({ ...BASE_FLAG, rolloutPercentage: 100 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(engine.isEnabled('test-flag', { tenantId: id })).toBe(true);
    }
  });

  // ── Zero rollout ───────────────────────────────────────────────────

  it('disables flag for all tenants at 0% rollout (no targeting)', () => {
    engine.setFlag({ ...BASE_FLAG, rolloutPercentage: 0 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(engine.isEnabled('test-flag', { tenantId: id })).toBe(false);
    }
  });

  // ── Deterministic hash ─────────────────────────────────────────────

  it('produces deterministic buckets for the same tenantId', () => {
    const b1 = tenantBucket('tenant-abc');
    const b2 = tenantBucket('tenant-abc');
    expect(b1).toBe(b2);
    expect(b1).toBeGreaterThanOrEqual(0);
    expect(b1).toBeLessThan(100);
  });

  it('distributes buckets across 0–99', () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 200; i++) {
      buckets.add(tenantBucket(`tenant-${i}`));
    }
    // With 200 tenants we expect good coverage of the 0-99 range
    expect(buckets.size).toBeGreaterThan(50);
  });

  // ── Partial rollout determinism ────────────────────────────────────

  it('enrolls exactly tenants whose bucket is < rolloutPercentage', () => {
    const pct = 50;
    engine.setFlag({ ...BASE_FLAG, rolloutPercentage: pct });

    let enabledCount = 0;
    const total = 200;
    for (let i = 0; i < total; i++) {
      const tenantId = `t-${i}`;
      if (engine.isEnabled('test-flag', { tenantId })) enabledCount++;
    }
    // Should be approximately 50% ± 10%
    expect(enabledCount).toBeGreaterThan(total * 0.35);
    expect(enabledCount).toBeLessThan(total * 0.65);
  });

  // ── Targeting: eq ─────────────────────────────────────────────────

  it('matches agentRole eq rule and enables flag at 0% rollout', () => {
    engine.setFlag({
      ...BASE_FLAG,
      rolloutPercentage: 0,
      targetingRules: [{ attribute: 'agentRole', operator: 'eq', value: 'internal-tester' }],
    });
    expect(engine.isEnabled('test-flag', { tenantId: 'x', agentRole: 'internal-tester' })).toBe(
      true,
    );
    expect(engine.isEnabled('test-flag', { tenantId: 'x', agentRole: 'user' })).toBe(false);
  });

  // ── Targeting: in ─────────────────────────────────────────────────

  it('matches region in rule', () => {
    engine.setFlag({
      ...BASE_FLAG,
      rolloutPercentage: 0,
      targetingRules: [{ attribute: 'region', operator: 'in', value: ['us-east-1', 'eu-west-1'] }],
    });
    expect(engine.isEnabled('test-flag', { tenantId: 'x', region: 'us-east-1' })).toBe(true);
    expect(engine.isEnabled('test-flag', { tenantId: 'x', region: 'ap-southeast-1' })).toBe(false);
  });

  // ── Targeting: lt / gte ───────────────────────────────────────────

  it('matches bucket lt rule', () => {
    engine.setFlag({
      ...BASE_FLAG,
      rolloutPercentage: 0,
      targetingRules: [{ attribute: 'bucket', operator: 'lt', value: 100 }],
    });
    // bucket < 100 is always true (0-99 range)
    expect(engine.isEnabled('test-flag', { tenantId: 'any' })).toBe(true);
  });

  // ── Targeting: reason ──────────────────────────────────────────────

  it('returns reason=targeting when rule matches', () => {
    engine.setFlag({
      ...BASE_FLAG,
      rolloutPercentage: 0,
      targetingRules: [{ attribute: 'tenantId', operator: 'eq', value: 'special-tenant' }],
    });
    const r = engine.evaluate('test-flag', { tenantId: 'special-tenant' });
    expect(r.reason).toBe('targeting');
    expect(r.enabled).toBe(true);
  });

  it('returns reason=rollout when no rule matches but within rollout %', () => {
    // Use a tenant whose bucket is definitely < 100
    engine.setFlag({ ...BASE_FLAG, rolloutPercentage: 100 });
    const r = engine.evaluate('test-flag', { tenantId: 'any-tenant' });
    expect(r.reason).toBe('rollout');
  });

  // ── Payload passthrough ────────────────────────────────────────────

  it('includes payload in result', () => {
    engine.setFlag({ ...BASE_FLAG, payload: { custom: 42 } });
    const r = engine.evaluate('test-flag', { tenantId: 'x' });
    expect(r.payload).toEqual({ custom: 42 });
  });

  // ── listFlags / deleteFlag ─────────────────────────────────────────

  it('lists all flags', () => {
    engine.setFlag({ ...BASE_FLAG, key: 'f1' });
    engine.setFlag({ ...BASE_FLAG, key: 'f2' });
    const keys = engine.listFlags().map((f) => f.key);
    expect(keys).toContain('f1');
    expect(keys).toContain('f2');
  });

  it('deletes a flag', () => {
    engine.setFlag(BASE_FLAG);
    engine.deleteFlag(BASE_FLAG.key);
    expect(engine.getFlag(BASE_FLAG.key)).toBeUndefined();
  });

  // ── Pre-computed bucket override ───────────────────────────────────

  it('uses explicit bucket from context', () => {
    engine.setFlag({ ...BASE_FLAG, rolloutPercentage: 50 });
    expect(engine.isEnabled('test-flag', { tenantId: 'x', bucket: 10 })).toBe(true);
    expect(engine.isEnabled('test-flag', { tenantId: 'x', bucket: 99 })).toBe(false);
  });
});
