import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureEngine } from '../engine';
import { ConfigStore, RedisHashClient } from '../config-store';

// ─── In-memory Redis hash mock ────────────────────────────────────────────

class MemoryHashRedis implements RedisHashClient {
  private hashes = new Map<string, Map<string, string>>();

  async hset(key: string, field: string, value: string): Promise<number> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
    return 1;
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hdel(key: string, field: string): Promise<number> {
    return this.hashes.get(key)?.delete(field) ? 1 : 0;
  }
  async hvals(key: string): Promise<string[]> {
    return [...(this.hashes.get(key)?.values() ?? [])];
  }
}

describe('ConfigStore', () => {
  let engine: FeatureEngine;
  let redis:  MemoryHashRedis;
  let store:  ConfigStore;

  beforeEach(async () => {
    engine = new FeatureEngine();
    redis  = new MemoryHashRedis();
    // Pass explicit yaml path pointing to the project config
    store  = new ConfigStore(engine, redis, `${process.cwd()}/src/config/flags.yaml`);
    await store.initialize();
    store.stop();
  });

  it('loads default flags from YAML on initialize', () => {
    const flags = engine.listFlags();
    expect(flags.length).toBeGreaterThan(0);
    const keys = flags.map(f => f.key);
    expect(keys).toContain('certification.minting');
  });

  it('upserts a flag and persists to Redis', async () => {
    await store.upsertFlag({
      key:               'new-flag',
      enabled:           true,
      rolloutPercentage: 25,
      targetingRules:    [],
      payload:           {},
      variants:          [],
    });
    const stored = await store.getFlag('new-flag');
    expect(stored).not.toBeNull();
    expect(stored!.rolloutPercentage).toBe(25);
  });

  it('updates existing flag in engine after upsert', async () => {
    await store.upsertFlag({
      key:               'certification.minting',
      enabled:           false,
      rolloutPercentage: 0,
      targetingRules:    [],
      payload:           {},
      variants:          [],
    });
    expect(engine.getFlag('certification.minting')?.enabled).toBe(false);
  });

  it('deletes a flag from engine and Redis', async () => {
    await store.upsertFlag({
      key: 'temp-flag', enabled: true, rolloutPercentage: 100,
      targetingRules: [], payload: {}, variants: [],
    });
    const existed = await store.deleteFlag('temp-flag');
    expect(existed).toBe(true);
    expect(engine.getFlag('temp-flag')).toBeUndefined();
  });

  it('returns false when deleting a non-existent flag', async () => {
    const existed = await store.deleteFlag('ghost-flag');
    expect(existed).toBe(false);
  });

  it('rejects flags with invalid key characters', async () => {
    await expect(store.upsertFlag({
      key: 'bad key!', enabled: true, rolloutPercentage: 50,
      targetingRules: [], payload: {}, variants: [],
    })).rejects.toThrow('Invalid flag key');
  });

  it('rejects rolloutPercentage out of range', async () => {
    await expect(store.upsertFlag({
      key: 'valid-key', enabled: true, rolloutPercentage: 150,
      targetingRules: [], payload: {}, variants: [],
    })).rejects.toThrow('rolloutPercentage');
  });

  it('resyncs engine state from Redis on syncFromRedis', async () => {
    // Write directly to Redis, bypassing engine
    await redis.hset('feature-flags:store', 'direct-flag', JSON.stringify({
      key: 'direct-flag', enabled: true, rolloutPercentage: 10,
      targetingRules: [], payload: {}, variants: [],
    }));
    await store.syncFromRedis();
    expect(engine.getFlag('direct-flag')?.rolloutPercentage).toBe(10);
  });
});
