import { PoolClient } from 'pg';
import { MonitoredPool } from './connection_pool';
import { metricsRegistry } from '../api/metrics/registry';
import { Gauge, Histogram } from 'prom-client';

export interface TenantContext {
  tenantId: string;
  tier: 1 | 2 | 3;
}

class QueueTimeoutError extends Error {
  retryAfter: number;
  constructor(message: string, retryAfter = 30) {
    super(message);
    this.retryAfter = retryAfter;
    this.name = 'QueueTimeoutError';
  }
}

type QueueEntry = {
  ctx: TenantContext;
  expensive: boolean;
  enqueuedAt: number;
  resolve: (client: PoolClient) => void;
  reject: (err: any) => void;
};

export class TenantAwarePool {
  private pools: Map<number, MonitoredPool> = new Map();
  private sharedPool: MonitoredPool;
  private queue: QueueEntry[] = [];
  private perTenantAcquired: Map<string, number> = new Map();
  private queueDepthGauge = new Gauge({
    name: 'tenant_query_queue_depth',
    help: 'Queue depth by tier',
    labelNames: ['tier'] as const,
    registers: [metricsRegistry],
  });
  private connectionUtilGauge = new Gauge({
    name: 'tenant_connection_utilization',
    help: 'Connection utilization by tier and tenant',
    labelNames: ['tier', 'tenant_id'] as const,
    registers: [metricsRegistry],
  });
  private queryLatency = new Histogram({
    name: 'tenant_query_latency_seconds',
    help: 'Query latency seconds',
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [metricsRegistry],
  });

  constructor(pgPoolFactory: (opts: any) => MonitoredPool) {
    // guaranteed minima
    this.pools.set(1, pgPoolFactory({ max: 50 }));
    this.pools.set(2, pgPoolFactory({ max: 30 }));
    this.pools.set(3, pgPoolFactory({ max: 10 }));
    this.sharedPool = pgPoolFactory({ max: 110 });

    // wire release listeners to attempt drain
    for (const p of this.pools.values()) {
      (p as any).pool.on('release', () => this.tryDrain());
      (p as any).pool.on('remove', () => this.tryDrain());
    }
    (this.sharedPool as any).pool.on('release', () => this.tryDrain());

    // periodic cleanup for timed-out queued entries
    setInterval(() => this.cleanupQueue(), 1000);
  }

  private recordAcquire(tenantId: string) {
    this.perTenantAcquired.set(tenantId, (this.perTenantAcquired.get(tenantId) || 0) + 1);
    // update metrics coarse-grained
    // sum per tier
    for (const [tier, pool] of this.pools.entries()) {
      this.connectionUtilGauge.set({ tier: String(tier) } as any, pool.getUtilization());
    }
  }

  private recordRelease(tenantId: string) {
    this.perTenantAcquired.set(
      tenantId,
      Math.max(0, (this.perTenantAcquired.get(tenantId) || 0) - 1),
    );
  }

  private async allocateConnection(ctx: TenantContext): Promise<PoolClient> {
    const tierPool = this.pools.get(ctx.tier)!;
    // prefer tier pool if capacity
    if (tierPool.getAcquired() < tierPool.getMaxConnections()) {
      const client = await (tierPool as any).pool.connect();
      return this.wrapClient(client, ctx);
    }

    // try shared
    if (this.sharedPool.getAcquired() < this.sharedPool.getMaxConnections()) {
      const client = await (this.sharedPool as any).pool.connect();
      return this.wrapClient(client, ctx);
    }

    // no immediate connection
    throw new Error('no-connection');
  }

  private wrapClient(client: PoolClient, ctx: TenantContext): PoolClient {
    const tenantId = ctx.tenantId;
    this.recordAcquire(tenantId);
    const origRelease = (client as any).release.bind(client);
    let finished = false;
    (client as any).release = () => {
      if (finished) return origRelease();
      finished = true;
      this.recordRelease(tenantId);
      origRelease();
    };
    return client;
  }

  async getConnection(ctx: TenantContext, opts?: { expensive?: boolean }): Promise<PoolClient> {
    // fast path
    try {
      const c = await this.allocateConnection(ctx);
      return c;
    } catch (e) {
      // decide whether to queue
      const expensive = !!opts?.expensive;
      if (expensive && ctx.tier === 3) {
        // if higher-tier demand exceeds guarantees, queue
        const t1 = this.pools.get(1)!.getAcquired();
        const t2 = this.pools.get(2)!.getAcquired();
        if (t1 >= 50 || t2 >= 30) {
          return await this.enqueue(ctx, expensive);
        }
      }
      // otherwise try to wait briefly on shared pool
      return await this.enqueue(ctx, expensive);
    }
  }

  private enqueue(ctx: TenantContext, expensive: boolean): Promise<PoolClient> {
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = { ctx, expensive, enqueuedAt: Date.now(), resolve, reject };
      this.queue.push(entry);
      this.updateQueueMetrics();
      this.tryDrain();
    });
  }

  private updateQueueMetrics() {
    const byTier: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    for (const q of this.queue) byTier[q.ctx.tier]++;
    for (const t of [1, 2, 3]) this.queueDepthGauge.set({ tier: String(t) } as any, byTier[t]);
  }

  private cleanupQueue() {
    const now = Date.now();
    const timeoutMs = 30_000;
    const remaining: QueueEntry[] = [];
    for (const e of this.queue) {
      if (now - e.enqueuedAt > timeoutMs) {
        e.reject(new QueueTimeoutError('Query queued too long', 30));
      } else {
        remaining.push(e);
      }
    }
    this.queue = remaining;
    this.updateQueueMetrics();
  }

  private async tryDrain() {
    if (this.queue.length === 0) return;
    // sort by tier (1 highest) then FIFO
    this.queue.sort((a, b) => {
      if (a.ctx.tier !== b.ctx.tier) return a.ctx.tier - b.ctx.tier;
      return a.enqueuedAt - b.enqueuedAt;
    });

    const remaining: QueueEntry[] = [];
    for (const entry of this.queue) {
      try {
        const client = await this.allocateConnection(entry.ctx);
        entry.resolve(client);
      } catch (e) {
        // keep in queue
        remaining.push(entry);
      }
    }
    this.queue = remaining;
    this.updateQueueMetrics();
  }
}

export { QueueTimeoutError };
export default TenantAwarePool;
