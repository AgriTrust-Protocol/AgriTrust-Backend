import { describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../src/cache';
import { MemoryRedis } from '../../src/webhooks/memory-redis';

const config = {
  enabled: true,
  namespace: 'test',
  defaultTtlSeconds: 1,
  criticalPathTtlSeconds: 2,
  operationTimeoutMs: 25,
};

describe('CacheService', () => {
  it('stores and retrieves JSON values with namespaced Redis keys', async () => {
    const redis = new MemoryRedis();
    const cache = new CacheService(redis, config);

    await expect(cache.setJson('farms/1', { id: 1 })).resolves.toBe(true);
    await expect(cache.getJson('farms/1')).resolves.toEqual({ id: 1 });
    await expect(redis.get('farms/1')).resolves.toBeNull();
  });

  it('loads once and reuses cached values through remember', async () => {
    const cache = new CacheService(new MemoryRedis(), config);
    const loader = vi.fn(async () => ({ score: 99 }));

    await expect(cache.remember('risk/1', loader, { critical: true })).resolves.toEqual({ score: 99 });
    await expect(cache.remember('risk/1', loader, { critical: true })).resolves.toEqual({ score: 99 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('returns loader data when cache operations exceed timeout', async () => {
    const slowClient = {
      get: () => new Promise<string | null>((resolve) => setTimeout(() => resolve('{"stale":true}'), 50)),
      set: async () => 'OK' as const,
    };
    const cache = new CacheService(slowClient, { ...config, operationTimeoutMs: 1 });

    await expect(cache.remember('slow', async () => ({ fresh: true }))).resolves.toEqual({ fresh: true });
  });
});
