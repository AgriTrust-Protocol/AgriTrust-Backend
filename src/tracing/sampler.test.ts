import { describe, it, expect } from 'vitest';
import { resolveSamplingProbability, sampleTraceId } from './sampler';
import { TraceContext } from './trace-context';

describe('resolveSamplingProbability (issue #177 route-based sampling)', () => {
  it('samples financial settlement routes at 100%', () => {
    expect(resolveSamplingProbability('POST', '/api/settlements', 0.8)).toBe(1);
    expect(resolveSamplingProbability('GET', '/api/settlements/abc', 0.8)).toBe(1);
  });

  it('samples read-only GET queries at 1%', () => {
    expect(resolveSamplingProbability('GET', '/api/cargo/123', 0.8)).toBe(0.01);
  });

  it('uses the configured default for other writes', () => {
    expect(resolveSamplingProbability('POST', '/api/cargo', 0.8)).toBe(0.8);
    expect(resolveSamplingProbability('PUT', '/api/inventory/1', 0.5)).toBe(0.5);
  });

  it('does not treat a lookalike prefix as a settlement route', () => {
    expect(resolveSamplingProbability('POST', '/api/settlements-report', 0.8)).toBe(0.8);
  });
});

describe('sampleTraceId', () => {
  it('always samples at probability 1 and never at 0', () => {
    const id = TraceContext.generateTraceId();
    expect(sampleTraceId(id, 1)).toBe(true);
    expect(sampleTraceId(id, 0)).toBe(false);
  });

  it('is deterministic for a given trace-id + probability', () => {
    const id = TraceContext.generateTraceId();
    expect(sampleTraceId(id, 0.5)).toBe(sampleTraceId(id, 0.5));
  });

  it('samples a low-first-byte trace-id at 1% but not a high one', () => {
    expect(sampleTraceId('00abc', 0.01)).toBe(true); // firstByte 0x00 <= 2.55
    expect(sampleTraceId('ffabc', 0.01)).toBe(false); // firstByte 0xff > 2.55
  });
});

describe('TraceContext.traceIdFromRequestId (X-Request-ID mapping)', () => {
  it('uses a 32-hex request id directly', () => {
    const id = 'a'.repeat(32);
    expect(TraceContext.traceIdFromRequestId(id)).toBe(id);
  });

  it('hashes a non-hex request id to a valid 32-hex trace-id, deterministically', () => {
    const t1 = TraceContext.traceIdFromRequestId('scanner-req-42');
    const t2 = TraceContext.traceIdFromRequestId('scanner-req-42');
    expect(t1).toMatch(/^[0-9a-f]{32}$/);
    expect(t1).toBe(t2);
    expect(t1).not.toBe('0'.repeat(32));
  });

  it('never maps to an all-zero trace-id', () => {
    expect(TraceContext.traceIdFromRequestId('0'.repeat(32))).not.toBe('0'.repeat(32));
  });
});
