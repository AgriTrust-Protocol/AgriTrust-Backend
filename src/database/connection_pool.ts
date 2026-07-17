import { Pool, PoolClient, PoolConfig } from 'pg';
import { backpressure, BackpressureLevel } from '../sensors/backpressure';

export type PoolHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface PoolHealthSnapshot {
  status: PoolHealthStatus;
  latencyMs: number;
  acquired: number;
  idle: number;
  max: number;
  utilization: number;
  waiting: number;
  lastError?: string;
  timestamp: number;
}

export interface AdaptivePoolOptions {
  min?: number;
  max?: number;
  maxLimit?: number;
  scaleUpUtilization?: number;
  scaleDownUtilization?: number;
  unhealthyLatencyMs?: number;
  degradedLatencyMs?: number;
  probeTimeoutMs?: number;
  resizeCooldownMs?: number;
  now?: () => number;
}

const DEFAULT_ADAPTIVE_OPTIONS: Required<Omit<AdaptivePoolOptions, 'now'>> = {
  min: 2,
  max: 10,
  maxLimit: 50,
  scaleUpUtilization: 0.85,
  scaleDownUtilization: 0.25,
  unhealthyLatencyMs: 100,
  degradedLatencyMs: 75,
  probeTimeoutMs: 100,
  resizeCooldownMs: 30_000,
};

class MonitoredPool {
  pool: Pool;
  private maxConnections: number;
  private readonly minConnections: number;
  private readonly maxLimit: number;
  private readonly scaleUpUtilization: number;
  private readonly scaleDownUtilization: number;
  private readonly unhealthyLatencyMs: number;
  private readonly degradedLatencyMs: number;
  private readonly probeTimeoutMs: number;
  private readonly resizeCooldownMs: number;
  private readonly now: () => number;
  private acquired: number = 0;
  private totalCreated: number = 0;
  private lastUtilization: number = 0;
  private lastResizeAt: number = 0;
  private lastHealth: PoolHealthSnapshot | undefined;

  constructor(config: PoolConfig & AdaptivePoolOptions) {
    const adaptive = { ...DEFAULT_ADAPTIVE_OPTIONS, ...config };
    this.maxConnections = adaptive.max;
    this.minConnections = Math.min(adaptive.min, adaptive.max);
    this.maxLimit = Math.max(adaptive.maxLimit, adaptive.max);
    this.scaleUpUtilization = adaptive.scaleUpUtilization;
    this.scaleDownUtilization = adaptive.scaleDownUtilization;
    this.unhealthyLatencyMs = adaptive.unhealthyLatencyMs;
    this.degradedLatencyMs = adaptive.degradedLatencyMs;
    this.probeTimeoutMs = adaptive.probeTimeoutMs;
    this.resizeCooldownMs = adaptive.resizeCooldownMs;
    this.now = adaptive.now ?? Date.now;
    this.pool = new Pool({ ...config, max: this.maxConnections });

    this.pool.on('connect', () => {
      this.totalCreated++;
      this.updateBackpressure();
    });

    this.pool.on('acquire', () => {
      this.acquired++;
      this.updateBackpressure();
    });

    this.pool.on('remove', () => {
      this.acquired = Math.max(0, this.acquired - 1);
      this.updateBackpressure();
    });

    this.pool.on('release', () => {
      this.acquired = Math.max(0, this.acquired - 1);
      this.updateBackpressure();
    });
  }

  private updateBackpressure(): void {
    const available = this.maxConnections - this.acquired;
    this.lastUtilization = this.maxConnections > 0
      ? (this.acquired / this.maxConnections) * 100
      : 0;

    const availableRatio = this.maxConnections > 0
      ? available / this.maxConnections
      : 0;

    if (availableRatio < 0.1) {
      backpressure.setBackpressure('connection_pool', BackpressureLevel.CRITICAL);
    } else if (availableRatio < 0.3) {
      backpressure.setBackpressure('connection_pool', BackpressureLevel.WARNING);
    } else {
      backpressure.setBackpressure('connection_pool', BackpressureLevel.NORMAL);
    }
  }

  async probeHealth(): Promise<PoolHealthSnapshot> {
    const startedAt = this.now();
    let client: PoolClient | undefined;

    try {
      client = await this.withTimeout(this.pool.connect(), this.probeTimeoutMs);
      await this.withTimeout(client.query('SELECT 1'), this.probeTimeoutMs);
      const latencyMs = this.now() - startedAt;
      const snapshot = this.buildHealthSnapshot(latencyMs);
      this.lastHealth = snapshot;
      this.adaptPoolSize(snapshot);
      return snapshot;
    } catch (err: unknown) {
      const latencyMs = this.now() - startedAt;
      const snapshot = this.buildHealthSnapshot(latencyMs, err instanceof Error ? err.message : String(err));
      this.lastHealth = snapshot;
      this.adaptPoolSize(snapshot);
      return snapshot;
    } finally {
      client?.release();
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`pool probe timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private buildHealthSnapshot(latencyMs: number, lastError?: string): PoolHealthSnapshot {
    const acquired = this.getAcquired();
    const max = this.getMaxConnections();
    const waiting = this.getWaitingCount();
    const utilization = max > 0 ? acquired / max : 0;
    const status: PoolHealthStatus = lastError || latencyMs >= this.unhealthyLatencyMs
      ? 'unhealthy'
      : (latencyMs >= this.degradedLatencyMs || utilization >= this.scaleUpUtilization || waiting > 0)
        ? 'degraded'
        : 'healthy';

    return {
      status,
      latencyMs,
      acquired,
      idle: Math.max(0, max - acquired),
      max,
      utilization,
      waiting,
      lastError,
      timestamp: this.now(),
    };
  }

  private adaptPoolSize(snapshot: PoolHealthSnapshot): void {
    if (snapshot.timestamp - this.lastResizeAt < this.resizeCooldownMs) return;

    if ((snapshot.utilization >= this.scaleUpUtilization || snapshot.waiting > 0) && this.maxConnections < this.maxLimit) {
      this.resize(Math.min(this.maxLimit, Math.ceil(this.maxConnections * 1.25) + 1));
      return;
    }

    if (snapshot.status === 'healthy' && snapshot.utilization <= this.scaleDownUtilization && this.maxConnections > this.minConnections) {
      this.resize(Math.max(this.minConnections, this.maxConnections - 1));
    }
  }

  private resize(nextMax: number): void {
    if (nextMax === this.maxConnections) return;
    this.maxConnections = nextMax;
    (this.pool.options as PoolConfig).max = nextMax;
    this.lastResizeAt = this.now();
    this.updateBackpressure();
  }

  getUtilization(): number {
    return this.lastUtilization;
  }

  getAcquired(): number {
    return typeof this.pool.totalCount === 'number' && typeof this.pool.idleCount === 'number'
      ? Math.max(0, this.pool.totalCount - this.pool.idleCount)
      : this.acquired;
  }

  getMaxConnections(): number {
    return this.maxConnections;
  }

  getWaitingCount(): number {
    return typeof this.pool.waitingCount === 'number' ? this.pool.waitingCount : 0;
  }

  getLastHealth(): PoolHealthSnapshot | undefined {
    return this.lastHealth;
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

export { MonitoredPool };

export function createMonitoredPool(opts: AdaptivePoolOptions & Partial<PoolConfig> = {}): MonitoredPool {
  const cfg: PoolConfig & AdaptivePoolOptions = {
    connectionString: process.env.DATABASE_URL,
    ...opts,
  };
  return new MonitoredPool(cfg);
}
