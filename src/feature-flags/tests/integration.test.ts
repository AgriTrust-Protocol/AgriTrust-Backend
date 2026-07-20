/**
 * Integration test — eventual consistency across two simulated nodes.
 *
 * Two separate FeatureEngine + ConfigStore + Propagator instances share
 * the same in-memory Redis mock. When Node 1 writes a flag, Node 2 must
 * observe the change via Pub/Sub propagation within 5 seconds.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureEngine, FlagDefinition } from '../engine';
import { ConfigStore, RedisHashClient } from '../config-store';
import { Propagator, PROPAGATION_CHANNEL, RedisPubSubClient, RedisPublishClient } from '../propagator';

// ─── Shared Redis mock supporting both hash operations and pub/sub ────────

class SharedRedis implements RedisHashClient, RedisPublishClient {
  private hashes = new Map<string, Map<string, string>>();
  private subscribers = new Map<string, Array<(ch: string, msg: string) => void>>();

  // Hash ops
  async hset(k: string, f: string, v: string) {
    if (!this.hashes.has(k)) this.hashes.set(k, new Map());
    this.hashes.get(k)!.set(f, v);
    return 1;
  }
  async hget(k: string, f: string) { return this.hashes.get(k)?.get(f) ?? null; }
  async hdel(k: string, f: string) { return this.hashes.get(k)?.delete(f) ? 1 : 0; }
  async hvals(k: string) { return [...(this.hashes.get(k)?.values() ?? [])]; }

  // Pub/sub ops
  async publish(ch: string, msg: string) {
    for (const listener of this.subscribers.get(ch) ?? []) {
      setImmediate(() => listener(ch, msg));
    }
    return 1;
  }

  createSubscriber(): RedisPubSubClient {
    const redis = this;
    return {
      async subscribe(channel: string) {
        if (!redis.subscribers.has(channel)) redis.subscribers.set(channel, []);
      },
      on(_event: 'message', listener: (ch: string, msg: string) => void) {
        const ch = PROPAGATION_CHANNEL;
        if (!redis.subscribers.has(ch)) redis.subscribers.set(ch, []);
        redis.subscribers.get(ch)!.push(listener);
        return this;
      },
    };
  }
}

const TEST_FLAG: FlagDefinition = {
  key: 'integration-flag', enabled: true, rolloutPercentage: 25,
  targetingRules: [], payload: { test: 42 }, variants: [],
};

describe('Integration: Eventual Consistency', () => {
  let redis: SharedRedis;

  let engineA:     FeatureEngine;
  let storeA:      ConfigStore;
  let propagatorA: Propagator;

  let engineB:     FeatureEngine;
  let storeB:      ConfigStore;
  let propagatorB: Propagator;

  beforeEach(async () => {
    redis = new SharedRedis();

    // Node A
    engineA     = new FeatureEngine();
    storeA      = new ConfigStore(engineA, redis);
    storeA.stop();
    propagatorA = new Propagator(engineA, storeA);
    await propagatorA.start(redis.createSubscriber());

    // Node B
    engineB     = new FeatureEngine();
    storeB      = new ConfigStore(engineB, redis);
    storeB.stop();
    propagatorB = new Propagator(engineB, storeB);
    await propagatorB.start(redis.createSubscriber());
  });

  it('propagates flag upsert from Node A to Node B within 5 seconds', async () => {
    // Node A writes
    await storeA.upsertFlag(TEST_FLAG);
    await Propagator.publish(redis, { action: 'upsert', flag: TEST_FLAG });

    // Wait for Pub/Sub delivery
    await waitMs(100);

    // Node B must now see the flag
    const flagB = engineB.getFlag(TEST_FLAG.key);
    expect(flagB).toBeDefined();
    expect(flagB?.rolloutPercentage).toBe(25);
  }, 5_000);

  it('propagates flag delete from Node A to Node B within 5 seconds', async () => {
    // Seed both nodes
    await storeA.upsertFlag(TEST_FLAG);
    await Propagator.publish(redis, { action: 'upsert', flag: TEST_FLAG });
    await waitMs(100);
    expect(engineB.getFlag(TEST_FLAG.key)).toBeDefined();

    // Node A deletes
    await storeA.deleteFlag(TEST_FLAG.key);
    await Propagator.publish(redis, { action: 'delete', key: TEST_FLAG.key });
    await waitMs(100);

    // Node B must reflect deletion
    expect(engineB.getFlag(TEST_FLAG.key)).toBeUndefined();
  }, 5_000);

  it('handles concurrent writes to the same flag (last write wins)', async () => {
    const flag1 = { ...TEST_FLAG, rolloutPercentage: 10 };
    const flag2 = { ...TEST_FLAG, rolloutPercentage: 90 };

    await storeA.upsertFlag(flag1);
    await Propagator.publish(redis, { action: 'upsert', flag: flag1 });

    await storeB.upsertFlag(flag2);
    await Propagator.publish(redis, { action: 'upsert', flag: flag2 });

    await waitMs(100);

    // Both nodes should converge to the latest published value (90)
    expect(engineA.getFlag(TEST_FLAG.key)?.rolloutPercentage).toBe(90);
    expect(engineB.getFlag(TEST_FLAG.key)?.rolloutPercentage).toBe(90);
  }, 5_000);
});

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
