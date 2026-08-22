import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RateLimiter,
  DeviceAwareBucket,
  computeRefillRate,
} from '../../src/api/middleware/rate_limit';
import { DeviceProfileStore } from '../../src/devices/profile_store';
import { DeviceProfile } from '../../src/devices/types';
import { extractDeviceContext, getLimiterKey } from '../../src/api/middleware/device_auth';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePayload(
  deviceId: string,
  battery: number,
  signal: number,
  firmwareVersion: string,
  firmwareOutdated: number,
): Buffer {
  const buf = Buffer.alloc(38);
  // deviceId (bytes 0-15)
  buf.write(deviceId.padEnd(16, ' '), 0, 16, 'ascii');
  // battery (byte 16)
  buf.writeUInt8(battery, 16);
  // signal (byte 17) — as int8
  buf.writeInt8(signal, 17);
  // firmwareVersion (bytes 18-31)
  buf.write(firmwareVersion.padEnd(14, ' '), 18, 14, 'ascii');
  // firmwareOutdated (byte 32)
  buf.writeUInt8(firmwareOutdated, 32);
  return buf;
}

function healthyProfile(deviceId: string): DeviceProfile {
  return {
    deviceId,
    power: { battery_level: 100, signal_strength: -50 },
    firmwareVersion: '2.4.1',
    isFirmwareOutdated: false,
    txIntervals: [],
    lastSeen: new Date(),
    createdAt: new Date(),
  };
}

function createLimiter(): { limiter: RateLimiter; store: DeviceProfileStore } {
  const store = new DeviceProfileStore();
  const limiter = new RateLimiter(store);
  return { limiter, store };
}

// ─── DeviceAwareBucket ───────────────────────────────────────────────────────

describe('DeviceAwareBucket', () => {
  it('starts with full tokens and consumes correctly', () => {
    const bucket = new DeviceAwareBucket('device-1', 120, 60);
    expect(bucket.tokens).toBe(120);

    // Consume all tokens
    for (let i = 0; i < 120; i++) {
      expect(bucket.consume()).toBe(true);
    }
    // Next request should be throttled
    expect(bucket.consume()).toBe(false);
  });

  it('refills tokens over time', async () => {
    const bucket = new DeviceAwareBucket('device-2', 60, 60); // 60 tokens, refill at 60/min = 1 token/sec
    // Drain all tokens
    for (let i = 0; i < 60; i++) {
      bucket.consume();
    }
    expect(bucket.consume()).toBe(false);

    // Wait ~1.1 seconds for 1 token to refill
    await new Promise((r) => setTimeout(r, 1100));
    expect(bucket.consume()).toBe(true);

    // Immediately after, no more tokens
    expect(bucket.consume()).toBe(false);
  }, 5000);

  it('recomputes refill rate', () => {
    const bucket = new DeviceAwareBucket('device-3', 120, 60);
    bucket.recomputeRefillRate(1); // 1 token per minute
    // Drain all
    for (let i = 0; i < 120; i++) bucket.consume();
    expect(bucket.consume()).toBe(false);
    // Refill rate is now 1/min, so after 1.1 seconds we still shouldn't have 1 token
  });
});

// ─── computeRefillRate ──────────────────────────────────────────────────────

describe('computeRefillRate', () => {
  it('returns default rate for healthy device', () => {
    const profile = healthyProfile('dev-1');
    const stats = { mean: 60, stddev: 10, sampleCount: 100 };
    const rate = computeRefillRate(profile, stats);
    expect(rate).toBe(60); // 60 * 1.0
  });

  it('throttles to ~1 req/min when battery < 15%', () => {
    const profile = healthyProfile('dev-2');
    profile.power.battery_level = 10;
    const stats = { mean: 60, stddev: 10, sampleCount: 100 };
    const rate = computeRefillRate(profile, stats);
    expect(rate).toBeCloseTo(60 * 0.02, 1); // 1.2
  });

  it('throttles to ~6 req/min when signal < -120 dBm', () => {
    const profile = healthyProfile('dev-3');
    profile.power.signal_strength = -125;
    const stats = { mean: 60, stddev: 10, sampleCount: 100 };
    const rate = computeRefillRate(profile, stats);
    expect(rate).toBeCloseTo(60 * 0.1, 1); // 6
  });

  it('throttles to ~30 req/min when firmware outdated', () => {
    const profile = healthyProfile('dev-4');
    profile.isFirmwareOutdated = true;
    const stats = { mean: 60, stddev: 10, sampleCount: 100 };
    const rate = computeRefillRate(profile, stats);
    expect(rate).toBeCloseTo(60 * 0.5, 1); // 30
  });

  it('throttles to ~30 req/min when tx rate > historical mean + 3σ', () => {
    const profile = healthyProfile('dev-5');
    // Normal interval is around 1000 ms; latest is 200 ms (much faster = anomalous)
    const stats = { mean: 1000, stddev: 200, sampleCount: 100 };
    profile.txIntervals = [200]; // very fast transmission
    const rate = computeRefillRate(profile, stats);
    // mean - 3σ = 1000 - 600 = 400; 200 < 400 → anomalous → x0.5
    expect(rate).toBeCloseTo(60 * 0.5, 1); // 30
  });

  it('combines multiple multipliers multiplicatively', () => {
    const profile = healthyProfile('dev-6');
    profile.power.battery_level = 10; // x0.02
    profile.power.signal_strength = -125; // x0.1
    profile.isFirmwareOutdated = true; // x0.5
    const stats = { mean: 60, stddev: 10, sampleCount: 100 };
    const rate = computeRefillRate(profile, stats);
    expect(rate).toBeCloseTo(60 * 0.02 * 0.1 * 0.5, 2); // 0.06
  });

  it('returns default rate when stats have too few samples', () => {
    const profile = healthyProfile('dev-7');
    profile.txIntervals = [50]; // anomalously fast
    const stats = { mean: 1000, stddev: 200, sampleCount: 5 }; // < 10 samples
    const rate = computeRefillRate(profile, stats);
    expect(rate).toBe(60); // no anomaly multiplier
  });
});

// ─── RateLimiter ─────────────────────────────────────────────────────────────

describe('RateLimiter with device profiles', () => {
  let limiter: RateLimiter;
  let store: DeviceProfileStore;

  beforeEach(() => {
    const created = createLimiter();
    limiter = created.limiter;
    store = created.store;
  });

  afterEach(() => {
    limiter.reset();
  });

  it('allows requests from a healthy device at full rate', () => {
    // Seed a healthy profile
    store.upsertProfile(healthyProfile('DEV-HEALTHY'));
    const payload = makePayload('DEV-HEALTHY', 100, -50, '2.4.1', 0);

    // First burst (up to 120 requests)
    for (let i = 0; i < 120; i++) {
      expect(limiter.allowRequest(payload, '192.168.1.1:5555')).toBe(true);
    }
    // 121st should be throttled
    expect(limiter.allowRequest(payload, '192.168.1.1:5555')).toBe(false);
  });

  it('throttles device with low battery to ~1 req/min', () => {
    store.upsertProfile(healthyProfile('DEV-LOWBATT'));
    const payload = makePayload('DEV-LOWBATT', 10, -50, '2.4.1', 0);

    // With battery=10%, refill rate = 60 * 0.02 = 1.2 tokens/min
    // Burst capacity is 120, so first 120 should be allowed
    for (let i = 0; i < 120; i++) {
      expect(limiter.allowRequest(payload, '192.168.1.2:5555')).toBe(true);
    }
    // After burst exhausted, refill rate is ~1.2/min → very slow
    expect(limiter.allowRequest(payload, '192.168.1.2:5555')).toBe(false);
  });

  it('falls back to IP-based limiting when deviceId is absent', () => {
    const payload = Buffer.from('short', 'ascii'); // < 38 bytes
    const fallbackId = '10.0.0.5:9999';

    // First request creates an IP-based bucket
    for (let i = 0; i < 120; i++) {
      expect(limiter.allowRequest(payload, fallbackId)).toBe(true);
    }
    expect(limiter.allowRequest(payload, fallbackId)).toBe(false);
  });

  it('creates separate buckets for different devices', () => {
    store.upsertProfile(healthyProfile('DEV-A'));
    store.upsertProfile(healthyProfile('DEV-B'));

    const payloadA = makePayload('DEV-A', 100, -50, '2.4.1', 0);
    const payloadB = makePayload('DEV-B', 100, -50, '2.4.1', 0);

    // Drain DEV-A
    for (let i = 0; i < 120; i++) {
      limiter.allowRequest(payloadA, '10.0.0.1:1111');
    }
    expect(limiter.allowRequest(payloadA, '10.0.0.1:1111')).toBe(false);

    // DEV-B should still have full burst
    expect(limiter.allowRequest(payloadB, '10.0.0.2:2222')).toBe(true);
  });

  it('recomputes refill rate per-request based on latest profile', () => {
    store.upsertProfile(healthyProfile('DEV-RECOMP'));
    const healthyPayload = makePayload('DEV-RECOMP', 100, -50, '2.4.1', 0);

    // Drain burst
    for (let i = 0; i < 120; i++) {
      limiter.allowRequest(healthyPayload, '10.0.0.3:3333');
    }
    expect(limiter.allowRequest(healthyPayload, '10.0.0.3:3333')).toBe(false);

    // Update profile to low battery — the next request should re-read the profile
    const profile = store.getProfile('DEV-RECOMP')!;
    profile.power.battery_level = 10;
    store.upsertProfile(profile);

    const lowBattPayload = makePayload('DEV-RECOMP', 10, -50, '2.4.1', 0);
    // Still throttled because bucket still has 0 tokens + refill is now tiny
    expect(limiter.allowRequest(lowBattPayload, '10.0.0.3:3333')).toBe(false);
  });
});

// ─── Device Context Extraction ──────────────────────────────────────────────

describe('extractDeviceContext', () => {
  it('extracts device metadata from binary payload header', () => {
    const payload = makePayload('SENSOR-42', 85, -72, '1.3.0', 0);
    const ctx = extractDeviceContext(payload, '192.168.1.100:4000');

    expect(ctx.deviceId).toBe('SENSOR-42');
    expect(ctx.powerMetrics).toEqual({ battery_level: 85, signal_strength: -72 });
    expect(ctx.firmwareVersion).toBe('1.3.0');
    expect(ctx.fallbackId).toBe('192.168.1.100:4000');
  });

  it('returns null deviceId for short payloads', () => {
    const payload = Buffer.from('tiny', 'ascii');
    const ctx = extractDeviceContext(payload, '10.0.0.1:5000');

    expect(ctx.deviceId).toBeNull();
    expect(ctx.powerMetrics).toBeNull();
    expect(ctx.firmwareVersion).toBeNull();
    expect(ctx.fallbackId).toBe('10.0.0.1:5000');
    expect(getLimiterKey(ctx)).toBe('10.0.0.1:5000');
  });

  it('returns null deviceId when deviceId field is all spaces', () => {
    const buf = Buffer.alloc(38);
    buf.write('                ', 0, 16, 'ascii'); // 16 spaces
    buf.writeUInt8(100, 16);
    buf.writeInt8(-50, 17);

    const ctx = extractDeviceContext(buf, '10.0.0.2:6000');
    expect(ctx.deviceId).toBeNull();
  });
});

// ─── Cleanup Cron ────────────────────────────────────────────────────────────

describe('RateLimiter cleanup cron', () => {
  it('startCleanupCron sets up a timer and stopCleanupCron removes it', () => {
    const store = new DeviceProfileStore();
    const limiter = new RateLimiter(store);

    limiter.startCleanupCron();
    expect((limiter as any).cleanupTimer).not.toBeNull();

    limiter.stopCleanupCron();
    expect((limiter as any).cleanupTimer).toBeNull();
  });

  it('does not create duplicate timers', () => {
    const store = new DeviceProfileStore();
    const limiter = new RateLimiter(store);

    limiter.startCleanupCron();
    const firstTimer = (limiter as any).cleanupTimer;
    limiter.startCleanupCron();
    expect((limiter as any).cleanupTimer).toBe(firstTimer);

    limiter.stopCleanupCron();
  });
});

// ─── DeviceProfileStore ──────────────────────────────────────────────────────

describe('DeviceProfileStore', () => {
  it('upserts and retrieves profiles', () => {
    const store = new DeviceProfileStore();
    const profile = healthyProfile('dev-store-1');
    store.upsertProfile(profile);

    const retrieved = store.getProfile('dev-store-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.deviceId).toBe('dev-store-1');
  });

  it('merges txIntervals on upsert', () => {
    const store = new DeviceProfileStore();
    const p1 = healthyProfile('dev-merge');
    p1.txIntervals = [1000, 1100];
    store.upsertProfile(p1);

    const p2 = healthyProfile('dev-merge');
    p2.txIntervals = [900];
    store.upsertProfile(p2);

    const retrieved = store.getProfile('dev-merge');
    expect(retrieved!.txIntervals).toEqual([1000, 1100, 900]);
  });

  it('cleans up stale devices', () => {
    const store = new DeviceProfileStore();

    const old = healthyProfile('old-device');
    old.lastSeen = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    store.upsertProfile(old);

    const recent = healthyProfile('recent-device');
    store.upsertProfile(recent);

    const removed = store.cleanupStaleDevices(60 * 60 * 1000); // 1 hour TTL
    expect(removed).toBe(1);
    expect(store.getProfile('old-device')).toBeUndefined();
    expect(store.getProfile('recent-device')).toBeDefined();
  });

  it('getHistoricalStats computes mean and stddev', () => {
    const store = new DeviceProfileStore();
    const profile = healthyProfile('dev-stats');
    profile.txIntervals = [1000, 1000, 1000, 1000]; // all same → stddev 0
    store.upsertProfile(profile);

    const stats = store.getHistoricalStats('dev-stats');
    expect(stats.mean).toBe(1000);
    expect(stats.stddev).toBe(0);
    expect(stats.sampleCount).toBe(4);
  });

  it('returns zero stats for unknown device', () => {
    const store = new DeviceProfileStore();
    const stats = store.getHistoricalStats('nonexistent');
    expect(stats.mean).toBe(0);
    expect(stats.stddev).toBe(0);
    expect(stats.sampleCount).toBe(0);
  });
});
