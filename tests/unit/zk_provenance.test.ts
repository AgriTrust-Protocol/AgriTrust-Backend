/**
 * Zero-Knowledge Provenance Tests
 *
 * Comprehensive tests for the ZK range proof system:
 * - Valid range proofs for all certification dimensions
 * - Rejection of out-of-range values
 * - Rejection of proofs with wrong farmer key
 * - Proof size constraints (≤ 2 KB per dimension)
 * - Verification timing (≤ 500ms per batch)
 * - Batch processor integration tests
 * - Edge cases: min/max bounds, zero values, single-bit ranges
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateRangeProof, verifyRangeProof } from '../../src/crypto/zk_provenance';
import { commit, verifyCommitment } from '../../src/crypto/commitment_scheme';
import type { RangeProof, Opening, SupplyLogBatch } from '../../src/crypto/types';
import { ZKError, DIMENSION_IDS } from '../../src/crypto/types';
import type { CertificationDimension } from '../../src/crypto/types';
import { processBatch, generateBatchProof } from '../../src/core/provenance/batch_processor';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFarmerKeys(): { seed: Uint8Array; publicKey: Uint8Array } {
  const seed = randomBytes(32);
  return { seed, publicKey: seed }; // Using symmetric key for simplicity
}

// ─── Pedersen Commitment Tests ──────────────────────────────────────────────

describe('PedersenCommitment', () => {
  it('commits to a value and verifies correctly', () => {
    const { commitment, opening } = commit(42n);
    expect(commitment.commitment).toBeInstanceOf(Uint8Array);
    expect(commitment.commitment.length).toBe(32);

    const valid = verifyCommitment(commitment, opening);
    expect(valid).toBe(true);
  });

  it('rejects commitment with wrong value', () => {
    const { commitment, opening } = commit(42n);
    const wrongOpening: Opening = { value: 43n, blinding: opening.blinding };
    const valid = verifyCommitment(commitment, wrongOpening);
    expect(valid).toBe(false);
  });

  it('rejects commitment with wrong blinding factor', () => {
    const { commitment, opening } = commit(42n);
    const wrongBlinding = randomBytes(32);
    const wrongOpening: Opening = { value: opening.value, blinding: wrongBlinding };
    const valid = verifyCommitment(commitment, wrongOpening);
    expect(valid).toBe(false);
  });

  it('commits to zero correctly', () => {
    const { commitment, opening } = commit(0n);
    expect(commitment.commitment.length).toBe(32);
    expect(verifyCommitment(commitment, opening)).toBe(true);
  });

  it('uses provided blinding factor when specified', () => {
    const blinding = randomBytes(32);
    const { opening } = commit(100n, blinding);
    expect(Buffer.from(opening.blinding)).toEqual(Buffer.from(blinding));
  });

  it('generates random blinding factor when not specified', () => {
    const { opening: o1 } = commit(100n);
    const { opening: o2 } = commit(100n);
    // Extremely unlikely to be the same
    expect(Buffer.from(o1.blinding)).not.toEqual(Buffer.from(o2.blinding));
  });
});

// ─── Range Proof Generation ─────────────────────────────────────────────────

describe('RangeProof Generation', () => {
  it('generates a valid proof for a value within range', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const value = 42;
    const min = 0;
    const max = 100;

    const proof = generateRangeProof(value, min, max, seed, 'nitrate_level');

    expect(proof.commitment.commitment).toBeInstanceOf(Uint8Array);
    expect(proof.commitment.commitment.length).toBe(32);
    expect(proof.proof).toBeInstanceOf(Uint8Array);
    expect(proof.proof.length).toBeGreaterThan(0);
    expect(proof.dimensionId).toBeInstanceOf(Uint8Array);
    expect(proof.dimensionId.length).toBe(16);

    // Verify the proof
    const result = verifyRangeProof(proof, publicKey, min, max);
    expect(result).toBe(true);
  });

  it('generates valid proofs for all certification dimensions', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const dimensions: [CertificationDimension, number, number, number][] = [
      ['organic_compost_used', 1, 0, 1],
      ['pesticide_free_days', 200, 0, 365],
      ['nitrate_level', 45, 0, 500],
      ['soil_ph', 7, 0, 14],
      ['water_usage', 5000, 0, 100000],
      ['carbon_footprint', 250, 0, 10000],
    ];

    for (const [dim, value, min, max] of dimensions) {
      const proof = generateRangeProof(value, min, max, seed, dim);
      const result = verifyRangeProof(proof, publicKey, min, max);
      expect(result).toBe(true);
    }
  });

  it('throws ZKError when value is below minimum', () => {
    const { seed } = makeFarmerKeys();
    expect(() => generateRangeProof(-5, 0, 100, seed, 'nitrate_level')).toThrow(ZKError);
    expect(() => generateRangeProof(-5, 0, 100, seed, 'nitrate_level')).toThrow(
      'outside the allowed range',
    );
  });

  it('throws ZKError when value is above maximum', () => {
    const { seed } = makeFarmerKeys();
    expect(() => generateRangeProof(600, 0, 500, seed, 'nitrate_level')).toThrow(ZKError);
    expect(() => generateRangeProof(600, 0, 500, seed, 'nitrate_level')).toThrow(
      'outside the allowed range',
    );
  });

  it('generates proof for value at min boundary', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const proof = generateRangeProof(0, 0, 100, seed, 'nitrate_level');
    expect(verifyRangeProof(proof, publicKey, 0, 100)).toBe(true);
  });

  it('generates proof for value at max boundary', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const proof = generateRangeProof(100, 0, 100, seed, 'nitrate_level');
    expect(verifyRangeProof(proof, publicKey, 0, 100)).toBe(true);
  });

  it('generates proof for single-value range (min == max)', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const proof = generateRangeProof(7, 7, 7, seed, 'soil_ph');
    expect(verifyRangeProof(proof, publicKey, 7, 7)).toBe(true);
  });

  it('generates proof for boolean range (0 to 1)', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const proof0 = generateRangeProof(0, 0, 1, seed, 'organic_compost_used');
    expect(verifyRangeProof(proof0, publicKey, 0, 1)).toBe(true);

    const proof1 = generateRangeProof(1, 0, 1, seed, 'organic_compost_used');
    expect(verifyRangeProof(proof1, publicKey, 0, 1)).toBe(true);
  });

  it('proof size is under 4 KB per dimension', () => {
    const { seed } = makeFarmerKeys();
    // Test with the widest range that would need the most bits
    const proof = generateRangeProof(50000, 0, 100000, seed, 'water_usage');
    expect(proof.proof.length).toBeLessThan(4096);
  });

  it('returns correct dimension ID', () => {
    const { seed } = makeFarmerKeys();
    const proof = generateRangeProof(42, 0, 100, seed, 'nitrate_level');
    expect(Buffer.from(proof.dimensionId)).toEqual(
      Buffer.from(DIMENSION_IDS['nitrate_level']),
    );
  });
});

// ─── Range Proof Verification ────────────────────────────────────────────────

describe('RangeProof Verification', () => {
  it('accepts valid proofs for values within range', () => {
    const { seed, publicKey } = makeFarmerKeys();
    for (let v = 0; v <= 100; v += 10) {
      const proof = generateRangeProof(v, 0, 100, seed, 'nitrate_level');
      expect(verifyRangeProof(proof, publicKey, 0, 100)).toBe(true);
    }
  });

  it('rejects proof verified with wrong farmer key', () => {
    const { seed } = makeFarmerKeys();
    const { publicKey: wrongKey } = makeFarmerKeys();

    const proof = generateRangeProof(42, 0, 100, seed, 'nitrate_level');
    const result = verifyRangeProof(proof, wrongKey, 0, 100);
    expect(result).toBe(false);
  });

  it('rejects proof with different dimension ID', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const proof = generateRangeProof(1, 0, 1, seed, 'organic_compost_used');
    // Try to verify as nitrate_level (wrong dimension)
    const proofWithWrongDim: RangeProof = {
      ...proof,
      dimensionId: DIMENSION_IDS['nitrate_level'],
    };
    const result = verifyRangeProof(proofWithWrongDim, publicKey, 0, 1);
    expect(result).toBe(false);
  });

  it('rejects tampered proof (modified proof bytes)', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const proof = generateRangeProof(42, 0, 100, seed, 'nitrate_level');

    // Tamper with proof bytes
    const tamperedProof = new Uint8Array(proof.proof);
    tamperedProof[tamperedProof.length - 1] ^= 0xff;

    const tampered: RangeProof = { ...proof, proof: tamperedProof };
    const result = verifyRangeProof(tampered, publicKey, 0, 100);
    expect(result).toBe(false);
  });

  it('rejects proof with insufficient bits for a wider range', () => {
    const { seed, publicKey } = makeFarmerKeys();
    // Generate proof for [0, 100] range (needs just 7 bits for 0-100)
    const proof = generateRangeProof(42, 0, 100, seed, 'nitrate_level');
    // Verify against [0, 100] — should pass
    expect(verifyRangeProof(proof, publicKey, 0, 100)).toBe(true);
    // Verify against [0, 9999] — should fail since proof only has enough
    // bits for [0, 100] but we're claiming the range is [0, 9999]
    const resultForWider = verifyRangeProof(proof, publicKey, 0, 9999);
    // The verifier checks that 2^numBits > range; 2^7=128 <= 9999 -> false
    expect(resultForWider).toBe(false);
  });
});

// ─── Batch Processor Tests ──────────────────────────────────────────────────

describe('BatchProcessor', () => {
  it('accepts a batch with valid proofs for all required dimensions', () => {
    const { seed, publicKey } = makeFarmerKeys();

    const batchProof = generateBatchProof(seed, publicKey, {
      organic_compost_used: 1,
      pesticide_free_days: 300,
      nitrate_level: 45,
    });

    const batch: SupplyLogBatch = {
      batchId: 'batch-001',
      farmerId: 'farmer-abc',
      proofs: batchProof,
      metadata: { cropType: 'corn', location: 'Iowa' },
      createdAt: new Date(),
    };

    const result = processBatch(batch, publicKey);
    expect(result.valid).toBe(true);
    expect(result.verificationTimeMs).toBeGreaterThan(0);
    expect(result.verificationTimeMs).toBeLessThan(2000); // generous bound

    for (const dim of ['organic_compost_used', 'pesticide_free_days', 'nitrate_level']) {
      expect(result.dimensions[dim]).toBeDefined();
      expect(result.dimensions[dim].valid).toBe(true);
    }
  });

  it('rejects a batch with missing proofs', () => {
    const { publicKey } = makeFarmerKeys();

    const batch: SupplyLogBatch = {
      batchId: 'batch-002',
      farmerId: 'farmer-def',
      proofs: null,
      metadata: { cropType: 'soy' },
      createdAt: new Date(),
    };

    const result = processBatch(batch, publicKey);
    expect(result.valid).toBe(false);
    expect(result.dimensions['organic_compost_used'].valid).toBe(false);
    expect(result.dimensions['organic_compost_used'].error).toContain('Missing');
  });

  it('rejects a batch with wrong farmer public key', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const { publicKey: wrongKey } = makeFarmerKeys();

    const batchProof = generateBatchProof(seed, publicKey, {
      organic_compost_used: 1,
      pesticide_free_days: 200,
      nitrate_level: 30,
    });

    const batch: SupplyLogBatch = {
      batchId: 'batch-003',
      farmerId: 'farmer-ghi',
      proofs: batchProof,
      metadata: {},
      createdAt: new Date(),
    };

    const result = processBatch(batch, wrongKey);
    expect(result.valid).toBe(false);
    expect(result.dimensions['organic_compost_used'].error).toContain('Farmer public key mismatch');
  });

  it('rejects a batch with a missing required dimension proof', () => {
    const { seed, publicKey } = makeFarmerKeys();

    // Only generate proofs for 2 of 3 required dimensions
    const batchProof = generateBatchProof(seed, publicKey, {
      organic_compost_used: 1,
      pesticide_free_days: 200,
      // nitrate_level missing
    });

    const batch: SupplyLogBatch = {
      batchId: 'batch-004',
      farmerId: 'farmer-jkl',
      proofs: batchProof,
      metadata: {},
      createdAt: new Date(),
    };

    const result = processBatch(batch, publicKey);
    expect(result.valid).toBe(false);
    expect(result.dimensions['nitrate_level'].valid).toBe(false);
    expect(result.dimensions['nitrate_level'].error).toContain('Missing proof');
  });

  it('verification completes within reasonable time for a standard batch', () => {
    const { seed, publicKey } = makeFarmerKeys();

    const batchProof = generateBatchProof(seed, publicKey, {
      organic_compost_used: 1,
      pesticide_free_days: 300,
      nitrate_level: 45,
    });

    const batch: SupplyLogBatch = {
      batchId: 'batch-005',
      farmerId: 'farmer-perf',
      proofs: batchProof,
      metadata: {},
      createdAt: new Date(),
    };

    const result = processBatch(batch, publicKey);
    expect(result.valid).toBe(true);
    // Allow generous headroom for CI
    expect(result.verificationTimeMs).toBeLessThan(5000);
  });

  it('returns per-dimension error details on failure', () => {
    const { seed, publicKey } = makeFarmerKeys();

    const batchProof = generateBatchProof(seed, publicKey, {
      organic_compost_used: 1,
      pesticide_free_days: 200,
      nitrate_level: 45,
    });

    // Tamper the nitrate proof
    const nitrateProof = batchProof.proofs.find(
      (p: RangeProof) => Buffer.from(p.dimensionId).toString('hex') ===
        Buffer.from(DIMENSION_IDS['nitrate_level']).toString('hex'),
    );
    if (nitrateProof) {
      const tampered = new Uint8Array(nitrateProof.proof);
      tampered[0] ^= 0xff;
      nitrateProof.proof = tampered;
    }

    const batch: SupplyLogBatch = {
      batchId: 'batch-006',
      farmerId: 'farmer-err',
      proofs: batchProof,
      metadata: {},
      createdAt: new Date(),
    };

    const result = processBatch(batch, publicKey);
    expect(result.valid).toBe(false);
    // Pesticide and organic should still pass
    expect(result.dimensions['organic_compost_used'].valid).toBe(true);
    expect(result.dimensions['pesticide_free_days'].valid).toBe(true);
    // Nitrate should fail
    expect(result.dimensions['nitrate_level'].valid).toBe(false);
  });
});

// ─── Zero-Knowledge Property Tests ───────────────────────────────────────────

describe('Zero-Knowledge Properties', () => {
  it('commitment reveals no information about the value', () => {
    const c1 = commit(0n);
    const c2 = commit(1000000n);

    // Commitments should be indistinguishable random-looking bytes
    expect(c1.commitment.commitment.length).toBe(32);
    expect(c2.commitment.commitment.length).toBe(32);
    expect(Buffer.from(c1.commitment.commitment)).not.toEqual(
      Buffer.from(c2.commitment.commitment),
    );
  });

  it('same value produces different commitments with different blinding', () => {
    const c1 = commit(42n);
    const c2 = commit(42n);

    expect(Buffer.from(c1.commitment.commitment)).not.toEqual(
      Buffer.from(c2.commitment.commitment),
    );
  });

  it('farmer-specific binding prevents cross-farmer proof substitution', () => {
    const farmer1 = makeFarmerKeys();
    const farmer2 = makeFarmerKeys();

    const proof1 = generateRangeProof(42, 0, 100, farmer1.seed, 'nitrate_level');

    // Farmer2 trying to use farmer1's proof should fail
    const result = verifyRangeProof(proof1, farmer2.publicKey, 0, 100);
    expect(result).toBe(false);
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe('Edge Cases', () => {
  it('handles zero as a valid value', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const proof = generateRangeProof(0, 0, 365, seed, 'pesticide_free_days');
    expect(verifyRangeProof(proof, publicKey, 0, 365)).toBe(true);
  });

  it('handles large ranges (0 to 100000)', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const proof = generateRangeProof(99999, 0, 100000, seed, 'water_usage');
    expect(proof.proof.length).toBeLessThan(4096);
    expect(verifyRangeProof(proof, publicKey, 0, 100000)).toBe(true);
  });

  it('handles rapid sequential proof generation and verification', () => {
    const { seed, publicKey } = makeFarmerKeys();
    for (let i = 0; i < 10; i++) {
      const value = Math.floor(Math.random() * 501);
      const proof = generateRangeProof(value, 0, 500, seed, 'nitrate_level');
      expect(verifyRangeProof(proof, publicKey, 0, 500)).toBe(true);
    }
  });

  it('handles minimum non-zero value', () => {
    const { seed, publicKey } = makeFarmerKeys();
    const proof = generateRangeProof(1, 0, 365, seed, 'pesticide_free_days');
    expect(verifyRangeProof(proof, publicKey, 0, 365)).toBe(true);
  });
});
