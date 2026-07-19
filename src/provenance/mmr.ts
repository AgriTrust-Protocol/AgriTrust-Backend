import { createHash } from 'crypto';

export interface MmrProofStep { direction: 'left' | 'right'; hash: string; }
export interface MmrPeak { start: number; size: number; hash: string; }
export interface MmrProof {
  leafIndex: number;
  leafHash: string;
  leafCount: number;
  path: MmrProofStep[];
  peaks: MmrPeak[];
  root: string;
}

interface Node { start: number; size: number; hash: Buffer; left?: Node; right?: Node; }

export function hashLeaf(data: Buffer): Buffer {
  return createHash('sha256').update(Buffer.from([0])).update(data).digest();
}

export function hashParent(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(Buffer.from([1])).update(left).update(right).digest();
}

export function bagPeakHashes(peaks: Buffer[]): Buffer {
  if (peaks.length === 0) return Buffer.alloc(32);
  return peaks.slice(1).reduce((root, peak) => hashParent(root, peak), peaks[0]);
}

export class MerkleMountainRange {
  private readonly leaves: Buffer[] = [];
  private peaks: Node[] = [];

  append(leafHash: Buffer): number {
    if (leafHash.length !== 32) throw new Error('leafHash must be 32 bytes');
    const index = this.leaves.length;
    this.leaves.push(Buffer.from(leafHash));
    let carry: Node = { start: index, size: 1, hash: Buffer.from(leafHash) };
    while (this.peaks.length > 0 && this.peaks[this.peaks.length - 1].size === carry.size) {
      const left = this.peaks.pop() as Node;
      carry = { start: left.start, size: left.size + carry.size, hash: hashParent(left.hash, carry.hash), left, right: carry };
    }
    this.peaks.push(carry);
    return index;
  }

  get leafCount(): number { return this.leaves.length; }
  get root(): Buffer { return bagPeakHashes(this.peaks.map((peak) => peak.hash)); }
  bagPeaks(): Buffer { return this.root; }
  getPeaks(): MmrPeak[] { return this.peaks.map(({ start, size, hash }) => ({ start, size, hash: hash.toString('hex') })); }

  generateProof(leafIndex: number): MmrProof {
    const peak = this.peaks.find((candidate) => leafIndex >= candidate.start && leafIndex < candidate.start + candidate.size);
    if (!peak) throw new Error('leaf index not found');
    const path: MmrProofStep[] = [];
    this.collectPath(peak, leafIndex, path);
    return { leafIndex, leafHash: this.leaves[leafIndex].toString('hex'), leafCount: this.leafCount, path, peaks: this.getPeaks(), root: this.root.toString('hex') };
  }

  private collectPath(node: Node, leafIndex: number, path: MmrProofStep[]): void {
    if (node.size === 1) return;
    const left = node.left as Node;
    const right = node.right as Node;
    if (leafIndex < right.start) {
      path.push({ direction: 'right', hash: right.hash.toString('hex') });
      this.collectPath(left, leafIndex, path);
    } else {
      path.push({ direction: 'left', hash: left.hash.toString('hex') });
      this.collectPath(right, leafIndex, path);
    }
  }

  static verifyProof(proof: MmrProof, expectedRoot: string | Buffer): boolean {
    let cursor = Buffer.from(proof.leafHash, 'hex');
    for (const step of [...proof.path].reverse()) {
      const sibling = Buffer.from(step.hash, 'hex');
      cursor = step.direction === 'left' ? hashParent(sibling, cursor) : hashParent(cursor, sibling);
    }
    const peaks = proof.peaks.map((peak) => Buffer.from(peak.hash, 'hex'));
    const containingPeak = proof.peaks.findIndex((peak) => proof.leafIndex >= peak.start && proof.leafIndex < peak.start + peak.size);
    if (containingPeak < 0) return false;
    peaks[containingPeak] = cursor;
    const root = bagPeakHashes(peaks);
    const expected = Buffer.isBuffer(expectedRoot) ? expectedRoot : Buffer.from(expectedRoot, 'hex');
    return root.equals(expected) && root.toString('hex') === proof.root;
  }
}
