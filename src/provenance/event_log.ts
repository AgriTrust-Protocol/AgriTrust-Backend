import { hashLeaf, MerkleMountainRange, MmrProof } from './mmr';
import { ProvenanceEvent, ProvenanceRecord, assertHash, serializeEvent } from './types';

export class ProvenanceEventLog {
  private readonly mmr = new MerkleMountainRange();
  private readonly byEventId = new Map<string, ProvenanceRecord>();
  private readonly byLeafIndex = new Map<number, ProvenanceRecord>();

  appendEvent(event: ProvenanceEvent): ProvenanceRecord {
    assertHash(event.eventId, 'eventId');
    assertHash(event.prevEventHash, 'prevEventHash');
    assertHash(event.payloadHash, 'payloadHash');
    const id = event.eventId.toString('hex');
    if (this.byEventId.has(id)) throw new Error(`duplicate provenance event ${id}`);
    const hash = hashLeaf(serializeEvent(event));
    const leafIndex = this.mmr.append(hash);
    const record = { event, hash, leafIndex, appendedAt: new Date() };
    this.byEventId.set(id, record);
    this.byLeafIndex.set(leafIndex, record);
    return record;
  }

  proveInclusion(eventId: Buffer | string): MmrProof {
    const id = Buffer.isBuffer(eventId) ? eventId.toString('hex') : eventId;
    const record = this.byEventId.get(id);
    if (!record) throw new Error('provenance event not found');
    return this.mmr.generateProof(record.leafIndex);
  }

  get root(): Buffer { return this.mmr.root; }
  get leafCount(): number { return this.mmr.leafCount; }
  recordsOlderThan(cutoff: Date): ProvenanceRecord[] { return [...this.byLeafIndex.values()].filter((record) => record.appendedAt < cutoff); }
  peaks() { return this.mmr.getPeaks(); }
}
