export type CloudProvider = 'aws' | 'gcp';
export type ReplicaRole = 'active' | 'passive';

export type RegionReplicaConfig = {
  id: string;
  provider: CloudProvider;
  region: string;
  role: ReplicaRole;
  endpoint: string;
  maxBandwidthMbps: number;
};

export type ReplicationConfig = {
  activeRegionId: string;
  lagTargetP99Ms: number;
  failoverRtoMs: number;
  rpoMs: number;
  healthCheckIntervalMs: number;
  activeUnreachablePromoteAfterMs: number;
  replicas: RegionReplicaConfig[];
};

const maxPassiveReplicas = 3;

export const replicationConfig: ReplicationConfig = {
  activeRegionId: process.env.REPLICATION_ACTIVE_REGION_ID ?? 'aws-us-east-1',
  lagTargetP99Ms: Number(process.env.REPLICATION_LAG_TARGET_MS ?? 2_000),
  failoverRtoMs: Number(process.env.REPLICATION_FAILOVER_RTO_MS ?? 60_000),
  rpoMs: Number(process.env.REPLICATION_RPO_MS ?? 5_000),
  healthCheckIntervalMs: Number(process.env.REPLICATION_HEALTH_INTERVAL_MS ?? 5_000),
  activeUnreachablePromoteAfterMs: Number(process.env.REPLICATION_PROMOTE_AFTER_MS ?? 30_000),
  replicas: [
    { id: 'aws-us-east-1', provider: 'aws', region: 'us-east-1', role: 'active', endpoint: process.env.REPLICATION_ACTIVE_ENDPOINT ?? 'grpc://active.replication.local:8443', maxBandwidthMbps: 50 },
    { id: 'aws-us-west-2', provider: 'aws', region: 'us-west-2', role: 'passive', endpoint: process.env.REPLICATION_PASSIVE_US_WEST_ENDPOINT ?? 'grpc://us-west.replication.local:8443', maxBandwidthMbps: 50 },
    { id: 'gcp-us-central1', provider: 'gcp', region: 'us-central1', role: 'passive', endpoint: process.env.REPLICATION_PASSIVE_GCP_CENTRAL_ENDPOINT ?? 'grpc://gcp-central.replication.local:8443', maxBandwidthMbps: 50 },
    { id: 'aws-eu-west-1', provider: 'aws', region: 'eu-west-1', role: 'passive', endpoint: process.env.REPLICATION_PASSIVE_EU_WEST_ENDPOINT ?? 'grpc://eu-west.replication.local:8443', maxBandwidthMbps: 50 },
  ],
};

export function validateReplicationConfig(config = replicationConfig): void {
  const active = config.replicas.filter((replica) => replica.role === 'active');
  const passive = config.replicas.filter((replica) => replica.role === 'passive');
  if (active.length !== 1) throw new Error('replication topology requires exactly one active primary');
  if (passive.length > maxPassiveReplicas) throw new Error(`replication topology supports at most ${maxPassiveReplicas} passive replicas`);
  if (config.replicas.some((replica) => replica.maxBandwidthMbps > 50)) throw new Error('replica link bandwidth must not exceed 50 Mbps');
}
