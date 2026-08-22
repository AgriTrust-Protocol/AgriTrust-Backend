import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FeatureEngine, FlagDefinition } from '../engine';
import { ConfigStore } from '../config-store';
import { Propagator, PROPAGATION_CHANNEL, RedisPubSubClient } from '../propagator';

// ─── In-memory mock helpers ───────────────────────────────────────────────

class MemoryHashRedis {
  private hashes = new Map<string, Map<string, string>>();
  async hset(k: string, f: string, v: string) {
    if (!this.hashes.has(k)) this.hashes.set(k, new Map());
    this.hashes.get(k)!.set(f, v);
    return 1;
  }
  async hget(k: string, f: string) {
    return this.hashes.get(k)?.get(f) ?? null;
  }
  async hdel(k: string, f: string) {
    return this.hashes.get(k)?.delete(f) ? 1 : 0;
  }
  async hvals(k: string) {
    return [...(this.hashes.get(k)?.values() ?? [])];
  }
}

/** Simulates a Redis subscriber — lets tests trigger messages manually. */
class SimulatedSubscriber implements RedisPubSubClient {
  private listeners: Array<(ch: string, msg: string) => void> = [];
  private subscribed = false;

  async subscribe(_channel: string): Promise<void> {
    this.subscribed = true;
  }

  on(_event: 'message', listener: (ch: string, msg: string) => void): this {
    this.listeners.push(listener);
    return this;
  }

  /** Test helper — fire a message as if Redis sent it. */
  emit(channel: string, message: string): void {
    for (const l of this.listeners) l(channel, message);
  }

  isSubscribed() {
    return this.subscribed;
  }
}

/** Minimal publish mock. */
function makePublisher() {
  const published: Array<{ channel: string; message: string }> = [];
  const publisher = {
    publish: vi.fn(async (channel: string, message: string) => {
      published.push({ channel, message });
      return 1;
    }),
    published,
  };
  return publisher;
}

const SAMPLE_FLAG: FlagDefinition = {
  key: 'prop-flag',
  enabled: true,
  rolloutPercentage: 50,
  targetingRules: [],
  payload: { v: 1 },
  variants: [],
};

describe('Propagator', () => {
  let engine: FeatureEngine;
  let store: ConfigStore;
  let propagator: Propagator;
  let subscriber: SimulatedSubscriber;

  beforeEach(async () => {
    engine = new FeatureEngine();
    const redis = new MemoryHashRedis();
    store = new ConfigStore(engine, redis);
    store.stop();
    propagator = new Propagator(engine, store);
    subscriber = new SimulatedSubscriber();
    await propagator.start(subscriber);
  });

  it('subscribes to the correct channel', () => {
    expect(subscriber.isSubscribed()).toBe(true);
  });

  it('applies upsert action to engine', () => {
    subscriber.emit(PROPAGATION_CHANNEL, JSON.stringify({ action: 'upsert', flag: SAMPLE_FLAG }));
    expect(engine.getFlag('prop-flag')).toMatchObject({ key: 'prop-flag', rolloutPercentage: 50 });
  });

  it('applies delete action to engine', () => {
    engine.setFlag(SAMPLE_FLAG);
    subscriber.emit(PROPAGATION_CHANNEL, JSON.stringify({ action: 'delete', key: 'prop-flag' }));
    expect(engine.getFlag('prop-flag')).toBeUndefined();
  });

  it('ignores messages on wrong channel', () => {
    engine.setFlag(SAMPLE_FLAG);
    subscriber.emit('other-channel', JSON.stringify({ action: 'delete', key: 'prop-flag' }));
    expect(engine.getFlag('prop-flag')).toBeDefined();
  });

  it('handles malformed JSON gracefully (no throw)', () => {
    expect(() => subscriber.emit(PROPAGATION_CHANNEL, '{ bad json')).not.toThrow();
  });

  it('Propagator.publish serialises action to the channel', async () => {
    const pub = makePublisher();
    await Propagator.publish(pub, { action: 'upsert', flag: SAMPLE_FLAG });
    expect(pub.publish).toHaveBeenCalledWith(
      PROPAGATION_CHANNEL,
      JSON.stringify({ action: 'upsert', flag: SAMPLE_FLAG }),
    );
  });
});
