import { DeviceProfile, DeviceStats } from '../../devices/types';
import { DeviceProfileStore } from '../../devices/profile_store';
import { extractDeviceContext, getLimiterKey, DeviceContext } from './device_auth';

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_RATE = 60; // requests per minute for a healthy device
const DEFAULT_CAPACITY = 120; // burst capacity (2 minutes of default rate)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_TTL_MS = 60 * 60 * 1000; // 1 hour
const LOW_BATTERY_THRESHOLD = 15; // %
const LOW_SIGNAL_THRESHOLD_DBM = -120;
const ANOMALY_SIGMA = 3;

// ─── Device-Aware Token Bucket ───────────────────────────────────────────────

export class DeviceAwareBucket {
  tokens: number;
  lastRefill: number;
  deviceId: string;
  maxTokens: number;
  refillRate: number; // tokens per minute

  constructor(
    deviceId: string,
    maxTokens: number = DEFAULT_CAPACITY,
    refillRate: number = DEFAULT_RATE,
  ) {
    this.deviceId = deviceId;
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Refills tokens based on elapsed time since last refill.
   * The refill rate is in tokens/minute.
   */
  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;

    const tokensToAdd = (elapsedMs / 60_000) * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Attempts to consume one token.  Returns true if allowed, false if throttled.
   */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Recomputes the refill rate based on a device profile.
   * Does not change maxTokens.
   */
  recomputeRefillRate(refillRate: number): void {
    this.refillRate = refillRate;
  }
}

// ─── Refill-Rate Computation ─────────────────────────────────────────────────

/**
 * Computes a per-device refill rate (tokens/minute) based on the device's
 * health profile and historical transmission pattern.
 *
 * Multipliers (applied multiplicatively):
 *   x0.02  when battery < 15%
 *   x0.1   when signal < -120 dBm
 *   x0.5   when firmware is outdated
 *   x0.5   when latest tx interval is more than 3σ below the historical mean (transmitting too fast)
 */
export function computeRefillRate(profile: DeviceProfile, stats: DeviceStats): number {
  let multiplier = 1.0;

  // Battery constraint
  if (profile.power.battery_level < LOW_BATTERY_THRESHOLD) {
    multiplier *= 0.02;
  }

  // Signal constraint
  if (profile.power.signal_strength < LOW_SIGNAL_THRESHOLD_DBM) {
    multiplier *= 0.1;
  }

  // Firmware constraint
  if (profile.isFirmwareOutdated) {
    multiplier *= 0.5;
  }

  // Anomaly detection: throttle if the most recent tx interval is more than 3σ
  // below the historical mean (i.e. the device is transmitting too fast).
  if (stats.sampleCount >= 10) {
    const latestInterval = profile.txIntervals[profile.txIntervals.length - 1];
    if (latestInterval !== undefined && stats.mean > 0) {
      const tooFastThreshold = stats.mean - ANOMALY_SIGMA * stats.stddev;
      if (tooFastThreshold > 0 && latestInterval < tooFastThreshold) {
        multiplier *= 0.5;
      }
    }
  }

  return DEFAULT_RATE * multiplier;
}

// ─── Rate Limiter (manages all device buckets) ────────────────────────────────

export class RateLimiter {
  private buckets: Map<string, DeviceAwareBucket> = new Map();
  private profileStore: DeviceProfileStore;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(profileStore: DeviceProfileStore) {
    this.profileStore = profileStore;
  }

  /**
   * Processes an incoming payload and determines whether the source device
   * should be allowed (returns true) or throttled (returns false).
   *
   * Side effects:
   *   - Creates or updates the device profile in the store.
   *   - Records the transmission interval for anomaly baselining.
   *   - Recomputes the refill rate on each request based on latest profile.
   */
  allowRequest(payload: Buffer, fallbackId: string): boolean {
    const ctx = extractDeviceContext(payload, fallbackId);
    const limiterKey = getLimiterKey(ctx);

    // Update device profile if deviceId is available
    if (ctx.deviceId && ctx.powerMetrics) {
      this.upsertProfileFromContext(ctx);
    }

    // Get or create bucket
    let bucket = this.buckets.get(limiterKey);
    if (!bucket) {
      bucket = new DeviceAwareBucket(limiterKey);
      this.buckets.set(limiterKey, bucket);
    }

    // Recompute refill rate from latest profile
    if (ctx.deviceId) {
      const profile = this.profileStore.getProfile(ctx.deviceId);
      if (profile) {
        const stats = this.profileStore.getHistoricalStats(ctx.deviceId);
        const refillRate = computeRefillRate(profile, stats);
        bucket.recomputeRefillRate(refillRate);
      }
    }

    return bucket.consume();
  }

  /**
   * Returns the current bucket for inspection in tests.
   */
  getBucket(key: string): DeviceAwareBucket | undefined {
    return this.buckets.get(key);
  }

  getBucketCount(): number {
    return this.buckets.size;
  }

  /**
   * Starts a background timer that purges stale device profiles
   * and their associated buckets every 5 minutes.
   */
  startCleanupCron(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.profileStore.cleanupStaleDevices(STALE_TTL_MS);

      // Remove buckets for devices that are no longer in the profile store.
      // Keep fallback (IP:port) buckets — they expire naturally via LRU eviction
      // when the bucket map grows beyond the profile store limit.
      const profileIds = new Set(this.profileStore.getAllProfiles().keys());
      for (const key of this.buckets.keys()) {
        if (!profileIds.has(key) && !this.isFallbackKey(key)) {
          this.buckets.delete(key);
        }
      }
    }, CLEANUP_INTERVAL_MS);

    // Allow the Node.js event loop to exit even with this timer running
    this.cleanupTimer.unref();
  }

  /**
   * Stops the cleanup cron job.
   */
  stopCleanupCron(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Removes all buckets (for testing).
   */
  reset(): void {
    this.buckets.clear();
    this.stopCleanupCron();
  }

  // ─── private helpers ──────────────────────────────────────────────────

  private isFallbackKey(key: string): boolean {
    // Fallback keys take the form "IP:port" (e.g., "192.168.1.1:5555")
    return key.includes(':') && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(key);
  }

  private upsertProfileFromContext(ctx: DeviceContext): void {
    if (!ctx.deviceId) return;

    const existing = this.profileStore.getProfile(ctx.deviceId);
    const now = new Date();

    const profile: DeviceProfile = {
      deviceId: ctx.deviceId,
      power: ctx.powerMetrics ?? { battery_level: 100, signal_strength: -50 },
      firmwareVersion: ctx.firmwareVersion ?? 'unknown',
      isFirmwareOutdated: existing?.isFirmwareOutdated ?? false,
      txIntervals: existing?.txIntervals ?? [],
      lastSeen: now,
      createdAt: existing?.createdAt ?? now,
    };

    this.profileStore.upsertProfile(profile);

    // Record the interval since last transmission
    if (existing) {
      const interval = now.getTime() - existing.lastSeen.getTime();
      if (interval > 0) {
        this.profileStore.recordTxInterval(ctx.deviceId, interval);
      }
    }
  }
}
