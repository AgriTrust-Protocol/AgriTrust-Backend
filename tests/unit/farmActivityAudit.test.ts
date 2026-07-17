import { describe, expect, it } from 'vitest';
import { canonicalJson, computeAuditHash, FarmActivityAuditService, AuditProof } from '../../src/audit/farmActivityAudit';

describe('farm activity audit hashing', () => {
  it('canonicalizes JSON before hashing so key order cannot alter proofs', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    const prev = Buffer.alloc(32);
    const timestamp = '2026-07-17T00:00:00.000Z';
    const one = computeAuditHash(prev, '11111111-1111-4111-8111-111111111111', timestamp, { b: 2, a: 1 });
    const two = computeAuditHash(prev, '11111111-1111-4111-8111-111111111111', timestamp, { a: 1, b: 2 });
    expect(one.toString('hex')).toBe(two.toString('hex'));
  });

  it('verifies chained audit proofs and rejects tampering', () => {
    const service = new FarmActivityAuditService({} as any);
    const timestampA = '2026-07-17T00:00:00.000Z';
    const timestampB = '2026-07-17T00:01:00.000Z';
    const eventA = '11111111-1111-4111-8111-111111111111';
    const eventB = '22222222-2222-4222-8222-222222222222';
    const zero = Buffer.alloc(32);
    const hashA = computeAuditHash(zero, eventA, timestampA, { action: 'plant' }).toString('hex');
    const hashB = computeAuditHash(Buffer.from(hashA, 'hex'), eventB, timestampB, { action: 'treat' }).toString('hex');
    const proof: AuditProof = {
      anchorEventId: eventA,
      latestEventId: eventB,
      steps: [
        { eventId: eventA, timestamp: timestampA, payload: { action: 'plant' }, prevHash: zero.toString('hex'), hash: hashA },
        { eventId: eventB, timestamp: timestampB, payload: { action: 'treat' }, prevHash: hashA, hash: hashB },
      ],
    };
    expect(service.verifyProof(proof)).toBe(true);
    expect(service.verifyProof({ ...proof, steps: proof.steps.map((step, i) => i === 1 ? { ...step, payload: { action: 'harvest' } } : step) })).toBe(false);
  });
});
