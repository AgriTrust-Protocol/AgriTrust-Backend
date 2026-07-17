import { describe, expect, it, vi } from 'vitest';

const poolState = vi.hoisted(() => ({
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
  connectLatencyMs: 0,
  queryLatencyMs: 0,
  failConnect: false,
}));

vi.mock('pg', async () => {
  const { EventEmitter } = await import('events');

  class FakePool extends EventEmitter {
    options: any;
    totalCount = poolState.totalCount;
    idleCount = poolState.idleCount;
    waitingCount = poolState.waitingCount;

    constructor(options: any) {
      super();
      this.options = options;
    }

    async connect() {
      if (poolState.failConnect) throw new Error('connect failed');
      this.totalCount = poolState.totalCount;
      this.idleCount = poolState.idleCount;
      this.waitingCount = poolState.waitingCount;
      if (poolState.connectLatencyMs > 0) await new Promise(resolve => setTimeout(resolve, poolState.connectLatencyMs));
      return {
        query: async () => {
          if (poolState.queryLatencyMs > 0) await new Promise(resolve => setTimeout(resolve, poolState.queryLatencyMs));
          return { rows: [{ '?column?': 1 }] };
        },
        release: vi.fn(),
      };
    }

    async end() { /* no-op */ }
  }

  return { Pool: FakePool };
});

import { MonitoredPool } from '../../src/database/connection_pool';

describe('MonitoredPool health probe and adaptive sizing', () => {
  it('reports degraded health and scales up when utilization is high', async () => {
    poolState.totalCount = 9;
    poolState.idleCount = 0;
    poolState.waitingCount = 2;
    poolState.failConnect = false;

    let now = 1_000;
    const pool = new MonitoredPool({
      max: 10,
      min: 2,
      maxLimit: 20,
      resizeCooldownMs: 0,
      now: () => now,
    });

    const snapshot = await pool.probeHealth();

    expect(snapshot.status).toBe('degraded');
    expect(snapshot.waiting).toBe(2);
    expect(pool.getMaxConnections()).toBe(14);
    expect((pool.pool.options as any).max).toBe(14);
  });

  it('reports unhealthy health without scaling down when probe fails', async () => {
    poolState.totalCount = 1;
    poolState.idleCount = 1;
    poolState.waitingCount = 0;
    poolState.failConnect = true;

    const pool = new MonitoredPool({ max: 10, min: 2, resizeCooldownMs: 0 });
    const snapshot = await pool.probeHealth();

    expect(snapshot.status).toBe('unhealthy');
    expect(snapshot.lastError).toContain('connect failed');
    expect(pool.getMaxConnections()).toBe(10);
  });

  it('scales down healthy underused pools no lower than the configured floor', async () => {
    poolState.totalCount = 2;
    poolState.idleCount = 2;
    poolState.waitingCount = 0;
    poolState.failConnect = false;

    const pool = new MonitoredPool({ max: 4, min: 3, resizeCooldownMs: 0 });
    const snapshot = await pool.probeHealth();

    expect(snapshot.status).toBe('healthy');
    expect(pool.getMaxConnections()).toBe(3);
  });
});
