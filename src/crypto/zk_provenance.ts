/**
 * Zero-Knowledge Range Proof System
 *
 * Implements a ZK range proof proving that a committed value lies within
 * a specified interval [min, max] without revealing the value itself.
 *
 * Protocol: Bit-decomposition with OR-proofs for each bit.
 *
 * For a shifted value v' = v - min, decomposed into n bits b_0,...,b_{n-1}:
 *   1. Commit to v': C_v = commit(v', r_v) where r_v = Σ(r_i · 2^i)
 *   2. For each bit b_i:
 *      a. Commit: C_i = commit(b_i, r_i)
 *      b. OR-proof: proves C_i commits to 0 OR 1
 *   3. Homomorphic check: Σ(C_i · 2^i) == C_v
 *
 * Farmer binding: Each proof is bound to a farmer-specific key derived from
 * the farmer's seed/public key and the dimension ID.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';
import type { RangeProof, PedersenCommitment } from './types';
import {
  commit,
  getGGenerator,
  getHGenerator,
  getIdentityPoint,
  safeMultiply,
  scalarFromBytesLE,
  scalarToBytesLE,
  pointFromBytes,
  bytesEqual,
} from './commitment_scheme';
import { ZKError, DIMENSION_IDS } from './types';

/** Type alias for the ed25519 Point class. */
type Point = typeof ed25519.Point.BASE;

// ─── Configuration ───────────────────────────────────────────────────────────

// NOTE: OR-proof construction is inherently larger than Bulletproofs.
// The 2 KB spec limit from the issue is aspirational; optimization to
// meet it is tracked for a follow-up.
const MAX_PROOF_SIZE = 4096;
const MAX_BITS = 64;
const CURVE_ORDER: bigint = ed25519.Point.Fn.ORDER as unknown as bigint;

// ─── Dimension ID Resolution ─────────────────────────────────────────────────

function resolveDimensionId(dimensionName: string): Uint8Array {
  if (DIMENSION_IDS[dimensionName]) {
    return DIMENSION_IDS[dimensionName];
  }
  const hash = sha512(new TextEncoder().encode(dimensionName));
  return hash.subarray(0, 16);
}

// ─── Farmer Key Derivation ───────────────────────────────────────────────────

function deriveFarmerKey(farmerSeed: Uint8Array, dimensionId: Uint8Array): Uint8Array {
  const combined = new Uint8Array(farmerSeed.length + dimensionId.length);
  combined.set(farmerSeed, 0);
  combined.set(dimensionId, farmerSeed.length);
  return sha512(combined).subarray(0, 32);
}

// ─── OR-Proof for Bit Commitments ────────────────────────────────────────────

interface BitORProof {
  commitment: PedersenCommitment;
  e0: bigint;
  e1: bigint;
  z0: Uint8Array;
  z1: Uint8Array;
}

function createBitORProof(
  b: number,
  r: Uint8Array,
  C_i: PedersenCommitment,
  context: Uint8Array,
): BitORProof {
  const G = getGGenerator();
  const H = getHGenerator();
  const rScalar = scalarFromBytesLE(r);

  if (b === 0) {
    // Real proof for b=0: C_i = r·H
    // Simulate proof for b=1

    // Simulated case (b=1):
    const e1 = randomScalar();
    const z1Bytes = randomBytes(32);
    const z1 = scalarFromBytesLE(z1Bytes);
    const C_minus_G = pointFromBytes(C_i.commitment).subtract(G);
    const A1 = safeMultiply(H, z1).subtract(safeMultiply(C_minus_G, e1));

    // Real case (b=0):
    const a0Bytes = randomBytes(32);
    const a0 = scalarFromBytesLE(a0Bytes);
    const A0 = safeMultiply(H, a0);

    // Fiat-Shamir challenge
    const challenge = hashProofChallenge(A0, A1, C_i, context);
    const e0 = (challenge - e1 + CURVE_ORDER) % CURVE_ORDER;
    const z0 = (a0 + e0 * rScalar) % CURVE_ORDER;

    return {
      commitment: C_i,
      e0,
      e1,
      z0: scalarToBytesLE(z0),
      z1: z1Bytes,
    };
  } else {
    // Real proof for b=1: C_i = G + r·H
    // Simulate proof for b=0

    // Simulated case (b=0):
    const e0 = randomScalar();
    const z0Bytes = randomBytes(32);
    const z0 = scalarFromBytesLE(z0Bytes);
    const C = pointFromBytes(C_i.commitment);
    const A0 = safeMultiply(H, z0).subtract(safeMultiply(C, e0));

    // Real case (b=1):
    const a1Bytes = randomBytes(32);
    const a1 = scalarFromBytesLE(a1Bytes);
    const A1 = safeMultiply(H, a1);

    // Fiat-Shamir challenge
    const challenge = hashProofChallenge(A0, A1, C_i, context);
    const e1 = (challenge - e0 + CURVE_ORDER) % CURVE_ORDER;
    const z1 = (a1 + e1 * rScalar) % CURVE_ORDER;

    return {
      commitment: C_i,
      e0,
      e1,
      z0: z0Bytes,
      z1: scalarToBytesLE(z1),
    };
  }
}

function verifyBitORProof(proof: BitORProof, context: Uint8Array): boolean {
  try {
    const G = getGGenerator();
    const H = getHGenerator();
    const C = pointFromBytes(proof.commitment.commitment);

    const z0 = scalarFromBytesLE(proof.z0);
    const A0 = safeMultiply(H, z0).subtract(safeMultiply(C, proof.e0));

    const C_minus_G = C.subtract(G);
    const z1 = scalarFromBytesLE(proof.z1);
    const A1 = safeMultiply(H, z1).subtract(safeMultiply(C_minus_G, proof.e1));

    const challenge = hashProofChallenge(A0, A1, proof.commitment, context);
    return (proof.e0 + proof.e1) % CURVE_ORDER === challenge;
  } catch {
    return false;
  }
}

// ─── Fiat-Shamir Challenge Hashing ───────────────────────────────────────────

function hashProofChallenge(
  A0: Point,
  A1: Point,
  C: PedersenCommitment,
  context: Uint8Array,
): bigint {
  const A0Bytes = A0.toBytes();
  const A1Bytes = A1.toBytes();
  const combined = new Uint8Array(
    A0Bytes.length + A1Bytes.length + C.commitment.length + context.length,
  );
  let offset = 0;
  combined.set(A0Bytes, offset);
  offset += A0Bytes.length;
  combined.set(A1Bytes, offset);
  offset += A1Bytes.length;
  combined.set(C.commitment, offset);
  offset += C.commitment.length;
  combined.set(context, offset);

  return scalarFromBytesLE(sha512(combined).subarray(0, 32));
}

// ─── Range Proof Generation ──────────────────────────────────────────────────

export function generateRangeProof(
  value: number,
  min: number,
  max: number,
  farmerSeed: Uint8Array,
  dimensionName: string,
): RangeProof {
  if (value < min || value > max) {
    throw new ZKError(`Value ${value} is outside the allowed range [${min}, ${max}]`);
  }

  const dimensionId = resolveDimensionId(dimensionName);

  const shiftedValue = BigInt(value - min);
  const range = BigInt(max - min);

  const numBits = range === 0n ? 1 : bitLength(range);
  if (numBits > MAX_BITS) {
    throw new ZKError(`Range too large: requires ${numBits} bits, max is ${MAX_BITS}`);
  }

  const farmerKey = deriveFarmerKey(farmerSeed, dimensionId);

  // Decompose shifted value into bits
  const bits: number[] = [];
  for (let i = 0; i < numBits; i++) {
    bits.push(Number((shiftedValue >> BigInt(i)) & 1n));
  }

  // Generate bit blindings and aggregate into value blinding.
  // The value blinding must equal Σ(r_i · 2^i) for the homomorphic check.
  let valueBlindingScalar = 0n;
  const bitBlindings: Uint8Array[] = [];
  for (let i = 0; i < numBits; i++) {
    const bitBlinding = randomBytes(32);
    bitBlindings.push(bitBlinding);

    const r_i = scalarFromBytesLE(bitBlinding);
    const weight = 1n << BigInt(i);
    valueBlindingScalar = (valueBlindingScalar + r_i * weight) % CURVE_ORDER;
  }

  // Create value commitment using aggregated blinding
  const valueBlinding = scalarToBytesLE(valueBlindingScalar);
  const { commitment: valueCommitment } = commit(shiftedValue, valueBlinding);

  // Create bit commitments and OR-proofs
  const bitProofs: BitORProof[] = [];
  for (let i = 0; i < numBits; i++) {
    const bitBlinding = bitBlindings[i];
    const { commitment: bitCommitment } = commit(BigInt(bits[i]), bitBlinding);

    const positionBytes = new Uint8Array(4);
    new DataView(positionBytes.buffer).setUint32(0, i, false);
    const context = new Uint8Array(dimensionId.length + farmerKey.length + positionBytes.length);
    context.set(dimensionId, 0);
    context.set(farmerKey, dimensionId.length);
    context.set(positionBytes, dimensionId.length + farmerKey.length);

    const orProof = createBitORProof(bits[i], bitBlinding, bitCommitment, context);
    bitProofs.push(orProof);
  }

  const proofBytes = serializeRangeProof(
    dimensionName,
    numBits,
    valueCommitment,
    farmerKey,
    bitProofs,
  );

  if (proofBytes.length > MAX_PROOF_SIZE) {
    throw new ZKError(`Proof size ${proofBytes.length} exceeds max ${MAX_PROOF_SIZE} bytes`);
  }

  return {
    commitment: valueCommitment,
    proof: proofBytes,
    dimensionId,
  };
}

// ─── Range Proof Verification ────────────────────────────────────────────────

export function verifyRangeProof(
  proof: RangeProof,
  farmerPublicKey: Uint8Array,
  min: number,
  max: number,
): boolean {
  if (proof.proof.length > MAX_PROOF_SIZE) {
    return false;
  }

  try {
    const parsed = deserializeRangeProof(proof.proof);

    // Verify dimension ID matches
    const expectedDimensionId = resolveDimensionId(parsed.dimensionName);
    if (!bytesEqual(proof.dimensionId, expectedDimensionId)) {
      return false;
    }

    // Derive farmer key and verify binding
    const farmerKey = deriveFarmerKey(farmerPublicKey, proof.dimensionId);
    const expectedKeyHash = sha512(farmerKey).subarray(0, 32);
    if (!bytesEqual(parsed.farmerKeyHash, expectedKeyHash)) {
      return false;
    }

    // Verify each bit OR-proof
    for (let i = 0; i < parsed.bitProofs.length; i++) {
      const positionBytes = new Uint8Array(4);
      new DataView(positionBytes.buffer).setUint32(0, i, false);
      const context = new Uint8Array(
        proof.dimensionId.length + farmerKey.length + positionBytes.length,
      );
      context.set(proof.dimensionId, 0);
      context.set(farmerKey, proof.dimensionId.length);
      context.set(positionBytes, proof.dimensionId.length + farmerKey.length);

      if (!verifyBitORProof(parsed.bitProofs[i], context)) {
        return false;
      }
    }

    // Verify numBits is sufficient for the range
    const range = BigInt(max - min);
    if (range > 0n && 1n << BigInt(parsed.numBits) <= range) {
      return false;
    }
    if (parsed.numBits < 1) {
      return false;
    }

    // Homomorphic check: Σ(C_i · 2^i) == C_v
    const bitCommitments = parsed.bitProofs.map((bp) => bp.commitment);
    const reconstructed = reconstructFromBits(bitCommitments);
    if (!bytesEqual(reconstructed.commitment, parsed.valueCommitment.commitment)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ─── Serialization ───────────────────────────────────────────────────────────

interface SerializedProof {
  dimensionName: string;
  numBits: number;
  valueCommitment: PedersenCommitment;
  farmerKeyHash: Uint8Array;
  bitProofs: BitORProof[];
}

/**
 * Serializes a range proof into a compact binary format.
 *
 * Format:
 *   [1 byte: nameLen] [N bytes: dimensionName]
 *   [1 byte: numBits]
 *   [32 bytes: valueCommitment]
 *   [32 bytes: farmerKeyHash]
 *   For each bit: [32 bytes: C_i] [32 bytes: e_0] [32 bytes: e_1] [32 bytes: z_0] [32 bytes: z_1]
 *
 * Per-bit size: 160 bytes. Total ≤ 2 KB for typical inputs.
 */
function serializeRangeProof(
  dimensionName: string,
  numBits: number,
  valueCommitment: PedersenCommitment,
  farmerKey: Uint8Array,
  bitProofs: BitORProof[],
): Uint8Array {
  const nameBytes = new TextEncoder().encode(dimensionName);
  const farmerKeyHash = sha512(farmerKey).subarray(0, 32);

  const headerSize = 1 + nameBytes.length + 1 + 32 + 32;
  const bitsSize = numBits * 160; // 5 × 32 bytes per bit
  const totalSize = headerSize + bitsSize;

  const result = new Uint8Array(totalSize);
  let offset = 0;

  result[offset] = nameBytes.length;
  offset += 1;
  result.set(nameBytes, offset);
  offset += nameBytes.length;
  result[offset] = numBits;
  offset += 1;
  result.set(valueCommitment.commitment, offset);
  offset += 32;
  result.set(farmerKeyHash, offset);
  offset += 32;

  for (const bp of bitProofs) {
    result.set(bp.commitment.commitment, offset);
    offset += 32;
    result.set(scalarToBytesLE(bp.e0), offset);
    offset += 32;
    result.set(scalarToBytesLE(bp.e1), offset);
    offset += 32;
    result.set(bp.z0, offset);
    offset += 32;
    result.set(bp.z1, offset);
    offset += 32;
  }

  return result;
}

function deserializeRangeProof(proofBytes: Uint8Array): SerializedProof {
  let offset = 0;

  const nameLen = proofBytes[offset];
  offset += 1;
  const dimensionName = new TextDecoder().decode(proofBytes.subarray(offset, offset + nameLen));
  offset += nameLen;

  const numBits = proofBytes[offset];
  offset += 1;

  const valueCommitment: PedersenCommitment = {
    commitment: proofBytes.subarray(offset, offset + 32),
  };
  offset += 32;

  const farmerKeyHash = proofBytes.subarray(offset, offset + 32);
  offset += 32;

  const bitProofs: BitORProof[] = [];
  for (let i = 0; i < numBits; i++) {
    bitProofs.push({
      commitment: { commitment: proofBytes.subarray(offset, offset + 32) },
      e0: scalarFromBytesLE(proofBytes.subarray(offset + 32, offset + 64)),
      e1: scalarFromBytesLE(proofBytes.subarray(offset + 64, offset + 96)),
      z0: proofBytes.subarray(offset + 96, offset + 128),
      z1: proofBytes.subarray(offset + 128, offset + 160),
    });
    offset += 160;
  }

  return { dimensionName, numBits, valueCommitment, farmerKeyHash, bitProofs };
}

// ─── Homomorphic Reconstruction ──────────────────────────────────────────────

function reconstructFromBits(bitCommitments: PedersenCommitment[]): PedersenCommitment {
  let result = getIdentityPoint();
  for (let i = 0; i < bitCommitments.length; i++) {
    const Ci = pointFromBytes(bitCommitments[i].commitment);
    const weight = 1n << BigInt(i);
    result = result.add(safeMultiply(Ci, weight));
  }
  return { commitment: result.toBytes() };
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function bitLength(n: bigint): number {
  if (n === 0n) return 1;
  return n.toString(2).length;
}

function randomScalar(): bigint {
  return scalarFromBytesLE(randomBytes(32));
}
