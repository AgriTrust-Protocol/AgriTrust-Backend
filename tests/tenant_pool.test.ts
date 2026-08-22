import { describe, it, expect } from 'vitest';
import TenantAwarePool from '../src/database/tenant_routing';

function makeFakePool(max: number, initialAcquired = 0) {
  const state = { acquired: initialAcquired, max };
  return {
    getAcquired: () => state.acquired,
    getMaxConnections: () => state.max,
    getUtilization: () => (state.acquired / state.max) * 100,
    pool: {
      connect: async () => {
        if (state.acquired < state.max) {
          state.acquired++;
          return {
            release: async () => {
              state.acquired = Math.max(0, state.acquired - 1);
            },
          } as any;
        }
        throw new Error('no-conn');
      },
      on: (_ev: string, _cb: any) => {
        /* no-op */
      },
    },
  } as any;
}

describe('TenantAwarePool prioritization', () => {
  it('prioritizes Tier 1 over Tier 3 under heavy load', async () => {
    // factory that produces fake pools; detect pool by max passed
    const factory = (opts: any) => {
      const max = opts.max || 10;
      if (max === 50) return makeFakePool(50, 0);
      if (max === 30) return makeFakePool(30, 0);
      if (max === 10) return makeFakePool(10, 10); // tier3 saturated
      if (max === 110) return makeFakePool(110, 110); // shared saturated
      return makeFakePool(max, 0);
    };

    const tap = new TenantAwarePool(factory as any);

    // start 50 Tier 3 expensive requests -> should be queued
    const tier3Promises = Array.from({ length: 50 }).map(() =>
      // intentionally do not await these in full — they represent long-running/queued work
      tap
        .getConnection({ tenantId: 't3', tier: 3 }, { expensive: true })
        .then((c) => {
          c.release();
          return true;
        })
        .catch(() => false),
    );

    // small pause
    await new Promise((r) => setTimeout(r, 10));

    // start 10 Tier 1 requests; these should complete quickly
    const t1Starts = Date.now();
    const tier1Promises = Array.from({ length: 10 }).map(() =>
      tap.getConnection({ tenantId: 't1', tier: 1 }).then(async (c) => {
        c.release();
        return Date.now();
      }),
    );

    const t1Times = await Promise.all(tier1Promises);
    for (const t of t1Times) {
      expect(t - t1Starts).toBeLessThan(500);
    }

    // We don't await all tier3 promises here because they may remain queued.
    // Check that at least one tier3 request has not immediately succeeded.
    const settled = await Promise.all(
      tier3Promises.map((p) => Promise.race([p, Promise.resolve('PENDING')])),
    );
    expect(settled.includes(true)).toBe(false);
  });
});
