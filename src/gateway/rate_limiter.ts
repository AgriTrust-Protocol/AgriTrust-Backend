export interface TokenBucketPolicy { capacity: number; refillPerMinute: number; }
export interface RateLimitDecision { allowed: boolean; remaining: number; retryAfterSeconds: number; limit: number; }

export const DEFAULT_TENANT_RATE_POLICIES: Record<'farm' | 'aggregator', TokenBucketPolicy> = {
  farm: { capacity: 1000, refillPerMinute: 1000 },
  aggregator: { capacity: 10000, refillPerMinute: 10000 },
};

class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  constructor(private readonly policy: TokenBucketPolicy, now: number) {
    this.tokens = policy.capacity;
    this.updatedAt = now;
  }
  consume(now: number, cost = 1): RateLimitDecision {
    const elapsedMinutes = Math.max(0, now - this.updatedAt) / 60_000;
    this.tokens = Math.min(this.policy.capacity, this.tokens + elapsedMinutes * this.policy.refillPerMinute);
    this.updatedAt = now;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: Math.floor(this.tokens), retryAfterSeconds: 0, limit: this.policy.capacity };
    }
    const missing = cost - this.tokens;
    return {
      allowed: false,
      remaining: Math.floor(this.tokens),
      retryAfterSeconds: Math.max(1, Math.ceil((missing / this.policy.refillPerMinute) * 60)),
      limit: this.policy.capacity,
    };
  }
}

export class TenantTokenBucketLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  constructor(
    private readonly policies: Record<'farm' | 'aggregator', TokenBucketPolicy> = DEFAULT_TENANT_RATE_POLICIES,
    private readonly now: () => number = () => Date.now(),
  ) {}

  allow(tenantId: string, rateLimitClass: 'farm' | 'aggregator', cost = 1): RateLimitDecision {
    const policy = this.policies[rateLimitClass];
    const key = `${tenantId}:${rateLimitClass}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(policy, this.now());
      this.buckets.set(key, bucket);
    }
    return bucket.consume(this.now(), cost);
  }
}
