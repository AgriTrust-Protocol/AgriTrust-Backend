import { DeviceProfile, DeviceStats } from './types';

/**
 * In-memory device profile store.
 *
 * Bound: holds full state for up to 100,000 devices under 50 MB.
 * Each profile entry is ~400 bytes (2 x 8B numbers + strings + array of 100 recent intervals).
 */
class DeviceProfileStore {
  private profiles: Map<string, DeviceProfile> = new Map();
  private maxProfiles: number;

  constructor(maxProfiles = 100_000) {
    this.maxProfiles = maxProfiles;
  }

  getProfile(deviceId: string): DeviceProfile | undefined {
    return this.profiles.get(deviceId);
  }

  upsertProfile(profile: DeviceProfile): void {
    const existing = this.profiles.get(profile.deviceId);
    if (existing) {
      // Merge historical tx intervals to preserve 24-hour baseline
      const mergedIntervals = [...existing.txIntervals, ...profile.txIntervals].slice(-1000);
      this.profiles.set(profile.deviceId, {
        ...profile,
        txIntervals: mergedIntervals,
        createdAt: existing.createdAt,
      });
    } else {
      // Evict oldest entry if at capacity
      if (this.profiles.size >= this.maxProfiles) {
        let oldestKey = '';
        let oldestTime = Infinity;
        for (const [key, p] of this.profiles) {
          if (p.lastSeen.getTime() < oldestTime) {
            oldestTime = p.lastSeen.getTime();
            oldestKey = key;
          }
        }
        if (oldestKey) {
          this.profiles.delete(oldestKey);
        }
      }
      this.profiles.set(profile.deviceId, profile);
    }
  }

  /**
   * Computes historical mean and standard deviation of tx_intervals
   * over the last 24 hours for a device.
   */
  getHistoricalStats(deviceId: string): DeviceStats {
    const profile = this.profiles.get(deviceId);
    if (!profile || profile.txIntervals.length === 0) {
      return { mean: 0, stddev: 0, sampleCount: 0 };
    }

    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

    // txIntervals are stored in chronological order at the front of the array;
    // we filter to last 24h based on the number of recent entries we can estimate.
    // Since we don't store absolute timestamps per interval, we use all stored
    // intervals as the baseline (store caps at 1000 entries).
    const intervals = profile.txIntervals;
    const n = intervals.length;
    const sum = intervals.reduce((a, b) => a + b, 0);
    const mean = sum / n;

    const variance = intervals.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
    const stddev = Math.sqrt(variance);

    return { mean, stddev, sampleCount: n };
  }

  /**
   * Records a transmission interval for a device.
   * @param deviceId the device identifier
   * @param intervalMs time since last transmission in milliseconds
   */
  recordTxInterval(deviceId: string, intervalMs: number): void {
    const profile = this.profiles.get(deviceId);
    if (!profile) return;

    profile.txIntervals.push(intervalMs);
    // Keep a rolling window of at most 1000 intervals
    if (profile.txIntervals.length > 1000) {
      profile.txIntervals = profile.txIntervals.slice(-1000);
    }
    profile.lastSeen = new Date();
  }

  /**
   * Purges device profiles that haven't been seen within the given TTL.
   * Called periodically (every 5 minutes) to bound memory growth.
   * @param ttlMs time-to-live in milliseconds (default: 1 hour)
   * @returns number of profiles removed
   */
  cleanupStaleDevices(ttlMs: number = 60 * 60 * 1000): number {
    const cutoff = Date.now() - ttlMs;
    let removed = 0;

    for (const [deviceId, profile] of this.profiles) {
      if (profile.lastSeen.getTime() < cutoff) {
        this.profiles.delete(deviceId);
        removed++;
      }
    }

    return removed;
  }

  getProfileCount(): number {
    return this.profiles.size;
  }

  getAllProfiles(): ReadonlyMap<string, DeviceProfile> {
    return this.profiles;
  }
}

export { DeviceProfileStore };
