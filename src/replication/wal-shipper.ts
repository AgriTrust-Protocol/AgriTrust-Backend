import { Pool } from 'pg';
import { RegionReplicaConfig } from '../config/replication';
import { CRDTDelta, DeltaAck, encodeDelta } from './delta-sync';
import { replicationBytesShippedTotal } from './metrics';

export interface ReplicaStream {
  send(delta: Buffer): Promise<DeltaAck>;
}

export interface ReplicaStreamFactory {
  connect(replica: RegionReplicaConfig): Promise<ReplicaStream>;
}

export type WalChange = { lsn: string; table: string; column: string; value: string | number; updatedAt: number; rowId: string };

export class WalShipper {
  constructor(private readonly pool: Pool, private readonly streamFactory: ReplicaStreamFactory, private readonly sourceRegion: string) {}

  async readLogicalSlot(slotName: string, limit = 100): Promise<WalChange[]> {
    const result = await this.pool.query('select * from pg_logical_slot_get_changes($1, null, $2)', [slotName, limit]);
    return result.rows.map((row) => JSON.parse(row.data) as WalChange);
  }

  toDelta(change: WalChange): CRDTDelta {
    const timestamp = { wallTime: change.updatedAt, logical: 0, nodeId: this.sourceRegion };
    if (change.table === 'attestations') return { kind: 'orset', field: 'attestations', snapshot: { adds: { [String(change.value)]: [`${change.rowId}:${change.lsn}`] }, removes: {} }, lsn: change.lsn, sourceRegion: this.sourceRegion };
    if (change.table === 'inventory') return { kind: 'pncounter', field: 'inventory', snapshot: { increments: { [this.sourceRegion]: Number(change.value) }, decrements: {} }, lsn: change.lsn, sourceRegion: this.sourceRegion };
    return { kind: 'lww', field: change.column === 'escrow_state' ? 'escrowState' : 'batchStatus', snapshot: { value: String(change.value), timestamp }, lsn: change.lsn, sourceRegion: this.sourceRegion };
  }

  async ship(change: WalChange, replicas: RegionReplicaConfig[]): Promise<DeltaAck[]> {
    const delta = this.toDelta(change);
    const payload = encodeDelta(delta);
    return Promise.all(replicas.map(async (replica) => {
      const stream = await this.streamFactory.connect(replica);
      const ack = await stream.send(payload);
      replicationBytesShippedTotal.inc({ source_region: this.sourceRegion, target_region: replica.id }, payload.byteLength);
      return ack;
    }));
  }
}
