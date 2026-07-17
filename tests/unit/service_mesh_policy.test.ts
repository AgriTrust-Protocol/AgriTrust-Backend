import { describe, expect, it } from 'vitest';
import { createServiceMeshPolicy, getServiceMeshPolicyFromEnv, serviceMeshReadiness } from '../../src/service-mesh/mtls-policy';

describe('service mesh mTLS policy', () => {
  it('defaults to strict mTLS with 100ms p99 and 99.99 availability guardrails', () => {
    const policy = createServiceMeshPolicy();

    expect(policy.provider).toBe('istio');
    expect(policy.mtlsMode).toBe('STRICT');
    expect(policy.criticalPathP99TargetMs).toBe(100);
    expect(policy.availabilityTarget).toBe(99.99);
    expect(policy.securityReviewRequired).toBe(true);
    expect(serviceMeshReadiness(policy).ready).toBe(true);
  });

  it('rejects permissive mTLS when mesh integration is enabled', () => {
    expect(() => createServiceMeshPolicy({ mtlsMode: 'PERMISSIVE' })).toThrow(/STRICT/);
  });

  it('rejects targets that exceed critical path latency requirements', () => {
    expect(() => createServiceMeshPolicy({ criticalPathP99TargetMs: 101 })).toThrow(/P99/);
  });

  it('loads provider and canary controls from environment', () => {
    const policy = getServiceMeshPolicyFromEnv({
      SERVICE_MESH_PROVIDER: 'linkerd',
      SERVICE_MESH_NAMESPACE: 'prod-agritrust',
      SERVICE_MESH_CANARY_INITIAL_WEIGHT: '10',
      SERVICE_MESH_CANARY_MAX_WEIGHT: '25',
      SERVICE_MESH_CANARY_ERROR_RATE_THRESHOLD: '0.5',
    });

    expect(policy.provider).toBe('linkerd');
    expect(policy.namespace).toBe('prod-agritrust');
    expect(policy.canary.initialWeightPercent).toBe(10);
    expect(policy.canary.maxWeightPercent).toBe(25);
    expect(policy.canary.errorRateThresholdPercent).toBe(0.5);
  });
});
