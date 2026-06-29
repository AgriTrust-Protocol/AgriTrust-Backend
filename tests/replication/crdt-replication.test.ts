import { describe, expect, it, vi } from 'vitest';
import { replicationConfig } from '../../src/config/replication';
import { LWWRegister, ORSet, PNCounter } from '../../src/replication/crdt-registry';
import { DeltaSync } from '../../src/replication/delta-sync';
import { HealthProbe, ReplicaManager } from '../../src/replication/replica-manager';

describe('CRDT primitives', () => {
  it('converges LWW registers, OR-Sets, and PN-Counters regardless of merge order', () => {
    const primaryStatus = new LWWRegister('harvested', { wallTime: 10, logical: 0, nodeId: 'active' });
    const replicaStatus = new LWWRegister('certified', { wallTime: 11, logical: 0, nodeId: 'passive' });
    expect(primaryStatus.merge(replicaStatus).value).toBe('certified');

    const activeTags = new ORSet<string>().add('organic', 'a:1').add('fair-trade', 'a:2');
    const passiveTags = new ORSet<string>().add('organic', 'p:1').remove('organic');
    expect(activeTags.merge(passiveTags).values().sort()).toEqual(['fair-trade', 'organic']);

    const activeInventory = new PNCounter().increment('active', 10).decrement('active', 2);
    const passiveInventory = new PNCounter().increment('passive', 4).decrement('passive', 1);
    expect(activeInventory.merge(passiveInventory).value()).toBe(11);
  });
});

describe('DeltaSync', () => {
  it('applies delta-only snapshots and tracks the acknowledged LSN', () => {
    const sync = new DeltaSync({
      batchStatus: new LWWRegister('created', { wallTime: 1, logical: 0, nodeId: 'seed' }),
      escrowState: new LWWRegister('locked', { wallTime: 1, logical: 0, nodeId: 'seed' }),
      attestations: new ORSet<string>(),
      inventory: new PNCounter(),
    }, 'aws-us-west-2');

    const ack = sync.apply({ kind: 'pncounter', field: 'inventory', snapshot: { increments: { active: 7 }, decrements: {} }, lsn: '0/16', sourceRegion: 'aws-us-east-1' });
    expect(ack).toMatchObject({ lsn: '0/16', replicaRegion: 'aws-us-west-2' });
  });
});

describe('ReplicaManager failover', () => {
  it('promotes the lowest-lag reachable passive after active outage threshold', async () => {
    vi.useFakeTimers();
    try {
      const promoted: string[] = [];
      const probe: HealthProbe = {
        async check(replica) {
          return { regionId: replica.id, reachable: replica.role === 'passive', lastLsn: replica.id === 'aws-us-west-2' ? '0/30' : '0/20', lagMs: replica.id === 'aws-us-west-2' ? 250 : 500, checkedAt: new Date() };
        },
        async promote(replica) { promoted.push(replica.id); },
      };
      const manager = new ReplicaManager({ ...replicationConfig, activeUnreachablePromoteAfterMs: 1 }, probe);
      await manager.checkOnce();
      vi.advanceTimersByTime(2);
      await manager.checkOnce();
      expect(promoted).toEqual(['aws-us-west-2']);
      expect(manager.mergeQuorumLsn()).toBe('0/30');
    } finally {
      vi.useRealTimers();
    }
  });
});
