import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { v1ToV2RequestTransform, v2ToV1ResponseTransform } from '../src/schemas/transforms/v1-to-v2';
import { performance } from 'perf_hooks';

describe('API Versioning Transformations', () => {
  it('should correctly transform v1 request to v2 (metadata -> context)', () => {
    fc.assert(
      fc.property(fc.record({ metadata: fc.dictionary(fc.string(), fc.anything()) }), (data) => {
        const transformed = v1ToV2RequestTransform(data);
        expect(transformed).toHaveProperty('context');
        expect(transformed.context).toEqual(data.metadata);
        expect(transformed).not.toHaveProperty('metadata');
      })
    );
  });

  it('should correctly transform v2 response to v1 (context -> metadata)', () => {
    fc.assert(
      fc.property(fc.record({ context: fc.dictionary(fc.string(), fc.anything()) }), (data) => {
        const transformed = v2ToV1ResponseTransform(data);
        expect(transformed).toHaveProperty('metadata');
        expect(transformed.metadata).toEqual(data.context);
        expect(transformed).not.toHaveProperty('context');
      })
    );
  });

  it('should be lossless for v1 -> v2 -> v1 transformation', () => {
    fc.assert(
      fc.property(fc.record({ metadata: fc.dictionary(fc.string(), fc.anything()) }), (data) => {
        const v2 = v1ToV2RequestTransform(data);
        // v1ToV2RequestTransform maps metadata to context
        // v2ToV1ResponseTransform maps context to metadata
        const v1Again = v2ToV1ResponseTransform(v2);
        expect(v1Again).toEqual(data);
      })
    );
  });

  it('should complete transformations within 50ms for 1MB payloads (p99)', () => {
    // Generate a 1MB payload roughly
    const largeMetadata = {};
    for (let i = 0; i < 10000; i++) {
      largeMetadata[`key_${i}`] = 'a'.repeat(100);
    }
    const payload = { metadata: largeMetadata };

    const iterations = 100;
    const durations: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      v1ToV2RequestTransform(payload);
      const end = performance.now();
      durations.push(end - start);
    }

    durations.sort((a, b) => a - b);
    const p99 = durations[Math.floor(iterations * 0.99)];

    console.log(`P99 Transformation Latency: ${p99}ms`);
    expect(p99).toBeLessThan(50);
  });
});
