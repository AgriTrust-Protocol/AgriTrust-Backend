import { EventEmitter } from 'events';
import { RegionReplicaConfig, ReplicationConfig } from '../config/replication';
import { maxLsn } from './delta-sync';
import { replicationLagSeconds } from './metrics';

export type ReplicaHealth = { regionId: string; reachable: boolean; lastLsn: string; lagMs: number; checkedAt: Date };

export interface HealthProbe {
  check(replica: RegionReplicaConfig): Promise<ReplicaHealth>;
  promote(replica: RegionReplicaConfig): Promise<void>;
}

export class ReplicaManager extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private activeUnreachableSince?: number;
  private health = new Map<string, ReplicaHealth>();

  constructor(private readonly config: ReplicationConfig, private readonly probe: HealthProbe) { super(); }

  start(): void {
    this.timer = setInterval(() => void this.checkOnce(), this.config.healthCheckIntervalMs);
    void this.checkOnce();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  async checkOnce(): Promise<void> {
    const results = await Promise.all(this.config.replicas.map((replica) => this.probe.check(replica)));
    for (const result of results) {
      this.health.set(result.regionId, result);
      const source = this.config.activeRegionId;
      if (result.regionId !== source) replicationLagSeconds.set({ source_region: source, target_region: result.regionId }, result.lagMs / 1000);
    }
    await this.maybeFailover();
  }

  getHealth(): ReplicaHealth[] { return [...this.health.values()]; }

  private async maybeFailover(): Promise<void> {
    const active = this.health.get(this.config.activeRegionId);
    if (active?.reachable) { this.activeUnreachableSince = undefined; return; }
    this.activeUnreachableSince ??= Date.now();
    if (Date.now() - this.activeUnreachableSince < this.config.activeUnreachablePromoteAfterMs) return;

    const candidate = this.bestReplica();
    if (!candidate) return;
    await this.probe.promote(candidate);
    this.emit('promoted', candidate.id);
  }

  private bestReplica(): RegionReplicaConfig | undefined {
    const passives = this.config.replicas.filter((replica) => replica.role === 'passive');
    return passives
      .filter((replica) => this.health.get(replica.id)?.reachable)
      .sort((a, b) => compareReplica(this.health.get(a.id)!, this.health.get(b.id)!))[0];
  }

  mergeQuorumLsn(): string | undefined {
    const reachable = [...this.health.values()].filter((health) => health.reachable);
    const quorum = Math.floor(this.config.replicas.length / 2) + 1;
    if (reachable.length < quorum) return undefined;
    return reachable.map((health) => health.lastLsn).reduce(maxLsn, '0/0');
  }
}

function compareReplica(a: ReplicaHealth, b: ReplicaHealth): number {
  const bestLsn = maxLsn(a.lastLsn, b.lastLsn);
  if (bestLsn === a.lastLsn && bestLsn !== b.lastLsn) return -1;
  if (bestLsn === b.lastLsn && bestLsn !== a.lastLsn) return 1;
  return a.lagMs - b.lagMs;
}
