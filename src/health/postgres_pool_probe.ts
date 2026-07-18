import { HealthCheckProbe, HealthStatus } from './checker';
import { MonitoredPool } from '../database/connection_pool';

export interface PostgresPoolProbeOptions {
  serviceName?: string;
  poolName?: string;
}

export function createPostgresPoolHealthProbe(
  pool: MonitoredPool,
  options: PostgresPoolProbeOptions = {},
): HealthCheckProbe {
  const serviceName = options.serviceName ?? 'postgres';
  const poolName = options.poolName ?? 'primary';

  return async (service: string) => {
    if (service !== serviceName && service !== poolName) {
      return { status: 'healthy' as HealthStatus };
    }

    const snapshot = await pool.probeHealth();
    return {
      status: snapshot.status,
      error: snapshot.lastError ?? (snapshot.status !== 'healthy'
        ? `pool ${poolName} ${snapshot.status}: ${snapshot.latencyMs}ms latency, ${Math.round(snapshot.utilization * 100)}% utilization, ${snapshot.waiting} waiting`
        : undefined),
    };
  };
}
