import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureEngine, FlagDefinition } from '../engine';
import { createFeatureFlagMiddleware } from '../../middleware/feature-flag';

const mockFlag: FlagDefinition = {
  key: 'mw-flag', enabled: true, rolloutPercentage: 100,
  targetingRules: [], payload: { test: true }, variants: [],
};

function makeReq(headers: Record<string, string> = {}) {
  return {
    header: (name: string) => headers[name.toLowerCase()] ?? undefined,
    ip:     '127.0.0.1',
    features: undefined as unknown,
  } as unknown as import('express').Request;
}

describe('createFeatureFlagMiddleware', () => {
  let engine: FeatureEngine;

  beforeEach(() => {
    engine = new FeatureEngine();
    engine.setFlag(mockFlag);
  });

  it('attaches req.features with isEnabled', () => {
    const mw = createFeatureFlagMiddleware(engine);
    const req = makeReq({ 'x-tenant-id': 'tenant-1' });
    mw(req, {} as import('express').Response, () => undefined);
    expect(req.features.isEnabled('mw-flag')).toBe(true);
    expect(req.features.isEnabled('unknown-flag')).toBe(false);
  });

  it('resolves tenantId from x-tenant-id header', () => {
    const mw = createFeatureFlagMiddleware(engine);
    const req = makeReq({ 'x-tenant-id': 'my-tenant' });
    mw(req, {} as import('express').Response, () => undefined);
    expect(req.features.context.tenantId).toBe('my-tenant');
  });

  it('falls back to req.ip when no header', () => {
    const mw = createFeatureFlagMiddleware(engine);
    const req = makeReq();
    mw(req, {} as import('express').Response, () => undefined);
    expect(req.features.context.tenantId).toBe('127.0.0.1');
  });

  it('resolves region from x-region header', () => {
    const mw = createFeatureFlagMiddleware(engine);
    const req = makeReq({ 'x-tenant-id': 't', 'x-region': 'eu-west-1' });
    mw(req, {} as import('express').Response, () => undefined);
    expect(req.features.context.region).toBe('eu-west-1');
  });

  it('resolves agentRole from x-agent-role header', () => {
    const mw = createFeatureFlagMiddleware(engine);
    const req = makeReq({ 'x-tenant-id': 't', 'x-agent-role': 'admin' });
    mw(req, {} as import('express').Response, () => undefined);
    expect(req.features.context.agentRole).toBe('admin');
  });

  it('evaluate returns EvaluationResult', () => {
    const mw = createFeatureFlagMiddleware(engine);
    const req = makeReq({ 'x-tenant-id': 't1' });
    mw(req, {} as import('express').Response, () => undefined);
    const result = req.features.evaluate('mw-flag');
    expect(result.enabled).toBe(true);
    expect(result.payload).toEqual({ test: true });
  });
});
