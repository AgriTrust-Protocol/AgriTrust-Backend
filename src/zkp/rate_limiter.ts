export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class FarmerVerificationRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly maxPerMinute = 1000,
    private readonly windowMs = 60_000,
  ) {}

  allow(farmerId: string, now = Date.now()): RateDecision {
    const since = now - this.windowMs;
    const bucket = (this.buckets.get(farmerId) ?? []).filter((entry) => entry > since);
    if (bucket.length >= this.maxPerMinute) {
      this.buckets.set(farmerId, bucket);
      const retryAfterSeconds = Math.ceil((bucket[0] + this.windowMs - now) / 1000);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    bucket.push(now);
    this.buckets.set(farmerId, bucket);
    return { allowed: true, remaining: this.maxPerMinute - bucket.length, retryAfterSeconds: 0 };
  }
}
