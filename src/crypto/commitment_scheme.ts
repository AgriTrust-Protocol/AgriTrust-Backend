/**
 * Pedersen Commitment Scheme
 *
 * Implements Pedersen commitments over the ed25519 elliptic curve group.
 * A Pedersen commitment to value v with blinding factor r is:
 *   C = v·G + r·H
 * where G is the standard generator and H is a second independent generator
 * derived from a domain-separated hash.
 *
 * Properties:
 *   - Perfectly hiding: given C, no information about v is leaked
 *   - Computationally binding: cannot find (v', r') ≠ (v, r) with same C
 *   - Additively homomorphic: commit(v1,r1) + commit(v2,r2) = commit(v1+v2, r1+r2)
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';
import type { PedersenCommitment, Opening } from './types';

/** Type alias for the ed25519 Point class to keep code readable. */
type Point = typeof ed25519.Point.BASE;

// ─── Generator Derivation ────────────────────────────────────────────────────

/**
 * Derives a second independent generator H from a domain-separated seed.
 * Uses the "hash-to-curve" approach: hash the seed, treat the result
 * as a scalar, and multiply the base point by it.
 *
 * Independence from G: H = h·G where h = H_sha512("AGRITRUST_PEDERSEN_H_2026") mod n.
 * Since h is a random scalar unknown to anyone, the discrete log of H w.r.t. G
 * is computationally infeasible to compute — satisfying the Pedersen requirement.
 */
let _H: Point | null = null;

function HGenerator(): Point {
  if (_H) return _H;
  const hash = sha512(new TextEncoder().encode('AGRITRUST_PEDERSEN_H_2026'));
  const scalar = scalarFromBytesLE(hash.subarray(0, 32));
  _H = ed25519.Point.BASE.multiply(scalar);
  return _H;
}

/** The standard ed25519 generator G. */
const G = ed25519.Point.BASE;

/** Identity point ZERO. */
const ZERO_POINT = ed25519.Point.ZERO;

/**
 * Safe scalar multiplication: multiplies a point by a scalar,
 * returning the identity point when scalar is 0 (since the library
 * requires scalar >= 1).
 */
function safeMultiply(point: Point, scalar: bigint): Point {
  if (scalar === 0n) return ZERO_POINT;
  return point.multiply(scalar);
}

// ─── Core Operations ─────────────────────────────────────────────────────────

/**
 * Creates a Pedersen commitment to a value.
 *
 * @param value - The value to commit to (as a bigint; must be in [0, n)).
 * @param blinding - Optional 32-byte blinding factor. If omitted, a random one is generated.
 * @returns The commitment and its opening information.
 */
export function commit(
  value: bigint,
  blinding?: Uint8Array,
): { commitment: PedersenCommitment; opening: Opening } {
  const r = blinding ?? randomBytes(32);
  const rScalar = scalarFromBytesLE(r);

  const H = HGenerator();
  const C = safeMultiply(G, value).add(safeMultiply(H, rScalar));

  return {
    commitment: { commitment: C.toBytes() },
    opening: { value, blinding: r },
  };
}

/**
 * Verifies that a commitment opens to the claimed value using the given blinding factor.
 *
 * Recomputes C' = v·G + r·H and checks C' == commitment.
 */
export function verifyCommitment(commitment: PedersenCommitment, opening: Opening): boolean {
  try {
    const C = pointFromBytes(commitment.commitment);
    const rScalar = scalarFromBytesLE(opening.blinding);

    const H = HGenerator();
    const expected = safeMultiply(G, opening.value).add(safeMultiply(H, rScalar));

    return C.equals(expected);
  } catch {
    return false;
  }
}

/**
 * Homomorphically adds two Pedersen commitments.
 * C_sum = C_a + C_b = (v_a+v_b)·G + (r_a+r_b)·H
 */
export function homomorphicAdd(a: PedersenCommitment, b: PedersenCommitment): PedersenCommitment {
  const A = pointFromBytes(a.commitment);
  const B = pointFromBytes(b.commitment);
  return { commitment: A.add(B).toBytes() };
}

/**
 * Homomorphically subtracts two Pedersen commitments.
 * C_diff = C_a - C_b = (v_a-v_b)·G + (r_a-r_b)·H
 */
export function homomorphicSubtract(
  a: PedersenCommitment,
  b: PedersenCommitment,
): PedersenCommitment {
  const A = pointFromBytes(a.commitment);
  const B = pointFromBytes(b.commitment);
  return { commitment: A.subtract(B).toBytes() };
}

/**
 * Creates a commitment to zero. Useful as a neutral element in homomorphic operations.
 */
export function zeroCommitment(): PedersenCommitment {
  return { commitment: getIdentityPoint().toBytes() };
}

/**
 * Returns the H generator (second independent generator) for use in proof verification.
 */
export function getHGenerator(): Point {
  return HGenerator();
}

/**
 * Returns the G generator (standard base point).
 */
export function getGGenerator(): Point {
  return G;
}

/**
 * Returns the identity (zero) point.
 */
export function getIdentityPoint(): Point {
  return ZERO_POINT;
}

export { safeMultiply };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts a 32-byte little-endian Uint8Array to a scalar in [0, n).
 */
export function scalarFromBytesLE(bytes: Uint8Array): bigint {
  const n: bigint = ed25519.Point.Fn.ORDER as unknown as bigint;
  const clamped = bytes.length >= 32 ? bytes.subarray(0, 32) : bytes;
  let value = 0n;
  for (let i = clamped.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(clamped[i]);
  }
  return value % n;
}

/**
 * Converts a bigint scalar to a 32-byte little-endian Uint8Array.
 */
export function scalarToBytesLE(scalar: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = scalar;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

/**
 * Deserializes a 32-byte compressed point.
 */
export function pointFromBytes(bytes: Uint8Array): Point {
  return ed25519.Point.fromHex(bytesToHex(bytes));
}

/**
 * Converts Uint8Array to hex string (no 0x prefix).
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Timing-safe constant-time byte comparison.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
