/**
 * Bloom filter for at-least-once delivery deduplication.
 *
 * Sized at 1 MB with a target false-positive rate < 0.1%.  The filter is
 * rebased (cleared and re-seeded from the acknowledged set) after each full
 * sync completion so the false-positive rate does not degrade over time.
 *
 * Hash family: double-hashing via two independent FNV-1a passes (offset by
 * seed) — no external dependency required.
 */

import { BLOOM_FILTER_BYTES, BLOOM_FALSE_POSITIVE_RATE } from '../types/attestation';

/** Number of bits in the bit-array. */
const BITS = BLOOM_FILTER_BYTES * 8; // 8 388 608 bits

/**
 * Optimal number of hash functions for the target FP rate.
 *   k = -ln(p) / ln(2) ≈ 10 for p = 0.001
 */
const NUM_HASHES = Math.ceil(-Math.log(BLOOM_FALSE_POSITIVE_RATE) / Math.LN2);

export class DedupFilter {
  private bits: Uint8Array;
  private itemCount: number;

  constructor() {
    this.bits = new Uint8Array(BLOOM_FILTER_BYTES);
    this.itemCount = 0;
  }

  /** Add an attestation ID to the filter. */
  add(id: string): void {
    const indices = this.hashIndices(id);
    for (const idx of indices) {
      const bytePos = idx >>> 3;
      const bitPos = idx & 7;
      this.bits[bytePos] |= 1 << bitPos;
    }
    this.itemCount++;
  }

  /** Test whether an ID *might* already be in the filter. */
  mightContain(id: string): boolean {
    const indices = this.hashIndices(id);
    for (const idx of indices) {
      const bytePos = idx >>> 3;
      const bitPos = idx & 7;
      if ((this.bits[bytePos] & (1 << bitPos)) === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Rebase: clear the filter and re-add a set of known IDs.
   * Called after a full sync to keep the FP rate bounded.
   */
  rebase(knownIds: string[]): void {
    this.bits.fill(0);
    this.itemCount = 0;
    for (const id of knownIds) {
      this.add(id);
    }
  }

  /** Number of items that have been added since the last rebase. */
  count(): number {
    return this.itemCount;
  }

  /**
   * Estimated current false-positive rate:
   *   (1 - e^(-k*n/m))^k
   */
  estimatedFalsePositiveRate(): number {
    const exponent = (-NUM_HASHES * this.itemCount) / BITS;
    return Math.pow(1 - Math.exp(exponent), NUM_HASHES);
  }

  /** Serialise the raw bit-array (e.g. for IndexedDB persistence). */
  serialise(): Uint8Array {
    return new Uint8Array(this.bits);
  }

  /** Restore from a previously serialised bit-array. */
  static deserialise(data: Uint8Array, itemCount: number): DedupFilter {
    const filter = new DedupFilter();
    if (data.length !== BLOOM_FILTER_BYTES) {
      throw new Error(`Expected ${BLOOM_FILTER_BYTES} bytes, got ${data.length}`);
    }
    filter.bits = new Uint8Array(data);
    filter.itemCount = itemCount;
    return filter;
  }

  // ── Hashing ────────────────────────────────────────────────────────────

  /**
   * Double-hashing: h(i) = (h1 + i * h2) mod BITS.
   * h1, h2 are two independent FNV-1a hashes with different seeds.
   */
  private hashIndices(key: string): number[] {
    const h1 = fnv1a(key, 0x811c9dc5);
    const h2 = fnv1a(key, 0xc4ceb9fe);
    const indices: number[] = [];
    for (let i = 0; i < NUM_HASHES; i++) {
      indices.push(Math.abs((h1 + i * h2) % BITS));
    }
    return indices;
  }
}

/**
 * FNV-1a 32-bit hash with a configurable initial basis.
 * Simple, fast, and produces adequate distribution for Bloom filters.
 */
function fnv1a(input: string, basis: number): number {
  let hash = basis;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // ensure unsigned 32-bit
}

export { BITS as BLOOM_BITS, NUM_HASHES as BLOOM_NUM_HASHES };
