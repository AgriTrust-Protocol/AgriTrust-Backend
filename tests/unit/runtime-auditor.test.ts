import { describe, expect, it } from 'vitest';
import { RuntimeConfigAuditor, detectDrift, hashSnapshot } from '../../src/config/runtime-auditor';

describe('RuntimeConfigAuditor', () => {
  it('hashes snapshots without exposing sensitive values', () => {
    const hashed = hashSnapshot({ API_TOKEN: 'secret-token', FEATURE_X: true });

    expect(hashed.API_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(hashed)).not.toContain('secret-token');
  });

  it('detects critical and warning drift against a baseline', () => {
    const baseline = hashSnapshot({ NODE_ENV: 'production', TRACING_SAMPLING_PROBABILITY: 0.8 });
    const actual = hashSnapshot({ NODE_ENV: 'development', TRACING_SAMPLING_PROBABILITY: 1 });

    expect(detectDrift(baseline, actual, new Set(['NODE_ENV']))).toEqual([
      expect.objectContaining({ key: 'NODE_ENV', severity: 'critical' }),
      expect.objectContaining({ key: 'TRACING_SAMPLING_PROBABILITY', severity: 'warning' }),
    ]);
  });

  it('audits in-process config and emits a stable redacted result', () => {
    let tracingProbability = 0.8;
    const auditor = new RuntimeConfigAuditor({
      service: 'api',
      criticalKeys: ['NODE_ENV'],
      clock: () => new Date('2026-07-18T00:00:00.000Z'),
      snapshot: () => ({ NODE_ENV: 'production', TRACING_SAMPLING_PROBABILITY: tracingProbability, DB_PASSWORD: 'secret' }),
    });

    auditor.establishBaseline();
    tracingProbability = 1;
    const result = auditor.audit();

    expect(result).toMatchObject({ service: 'api', checkedAt: '2026-07-18T00:00:00.000Z' });
    expect(result.drift).toEqual([expect.objectContaining({ key: 'TRACING_SAMPLING_PROBABILITY', severity: 'warning' })]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.durationMs).toBeLessThan(100);
  });
});
