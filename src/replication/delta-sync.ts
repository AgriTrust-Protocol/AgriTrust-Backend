import { ApplicationCRDTState, LWWRegister, ORSet, PNCounter } from './crdt-registry';

export type CRDTDelta =
  | { kind: 'lww'; field: 'batchStatus' | 'escrowState'; snapshot: ReturnType<LWWRegister<string>['toSnapshot']>; lsn: string; sourceRegion: string }
  | { kind: 'orset'; field: 'attestations'; snapshot: ReturnType<ORSet<string>['toSnapshot']>; lsn: string; sourceRegion: string }
  | { kind: 'pncounter'; field: 'inventory'; snapshot: ReturnType<PNCounter['toSnapshot']>; lsn: string; sourceRegion: string };

export type DeltaAck = { lsn: string; appliedAt: Date; replicaRegion: string };

export class DeltaSync {
  private lastAppliedLsn = '0/0';
  constructor(private readonly state: ApplicationCRDTState, private readonly replicaRegion: string) {}

  apply(delta: CRDTDelta): DeltaAck {
    switch (delta.kind) {
      case 'lww':
        this.state[delta.field].merge(LWWRegister.fromSnapshot(delta.snapshot));
        break;
      case 'orset':
        this.state.attestations.merge(ORSet.fromSnapshot(delta.snapshot));
        break;
      case 'pncounter':
        this.state.inventory.merge(PNCounter.fromSnapshot(delta.snapshot));
        break;
    }
    this.lastAppliedLsn = maxLsn(this.lastAppliedLsn, delta.lsn);
    return { lsn: this.lastAppliedLsn, appliedAt: new Date(), replicaRegion: this.replicaRegion };
  }

  getLastAppliedLsn(): string { return this.lastAppliedLsn; }
}

export function encodeDelta(delta: CRDTDelta): Buffer { return Buffer.from(JSON.stringify(delta)); }
export function decodeDelta(buffer: Buffer): CRDTDelta { return JSON.parse(buffer.toString('utf8')) as CRDTDelta; }

export function maxLsn(a: string, b: string): string {
  const [ahi, alo] = a.split('/').map((part) => parseInt(part, 16));
  const [bhi, blo] = b.split('/').map((part) => parseInt(part, 16));
  if (bhi > ahi || (bhi === ahi && blo > alo)) return b;
  return a;
}
