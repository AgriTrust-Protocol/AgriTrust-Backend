import { NextFunction, Request, RequestHandler, Response } from 'express';
import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../metrics/registry';

export interface TenantRateLimitPolicy {
  capacity: number;
  refillRatePerMinute: number;
}

export interface TenantRateLimitOptions {
  defaultPolicy?: TenantRateLimitPolicy;
  tierPolicies?: Partial<Record<1 | 2 | 3, TenantRateLimitPolicy>>;
  tenantPolicies?: Record<string, TenantRateLimitPolicy>;
  tenantIdHeader?: string;
  now?: () => number;
}

export interface TenantContext {
  tenantId: string;
  tier: 1 | 2 | 3;
}

export const DEFAULT_TENANT_POLICY: TenantRateLimitPolicy = {
  capacity: Number(process.env.TENANT_RATE_LIMIT_CAPACITY ?? 600),
  refillRatePerMinute: Number(process.env.TENANT_RATE_LIMIT_REFILL_PER_MINUTE ?? 300),
};

export const DEFAULT_TIER_POLICIES: Record<1 | 2 | 3, TenantRateLimitPolicy> = {
  1: { capacity: 2_000, refillRatePerMinute: 1_000 },
  2: { capacity: 1_000, refillRatePerMinute: 500 },
  3: DEFAULT_TENANT_POLICY,
};

export class TenantTokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private policy: TenantRateLimitPolicy,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = policy.capacity;
    this.lastRefillMs = now();
  }

  consume(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  updatePolicy(policy: TenantRateLimitPolicy): void {
    this.refill();
    this.policy = policy;
    this.tokens = Math.min(this.tokens, policy.capacity);
  }

  snapshot(): { tokens: number; capacity: number; refillRatePerMinute: number } {
    this.refill();
    return { tokens: this.tokens, ...this.policy };
  }

  retryAfterSeconds(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    const deficit = cost - this.tokens;
    return Math.ceil((deficit / this.policy.refillRatePerMinute) * 60);
  }

  private refill(): void {
    const current = this.now();
    const elapsedMs = current - this.lastRefillMs;
    if (elapsedMs <= 0) return;

    const tokensToAdd = (elapsedMs / 60_000) * this.policy.refillRatePerMinute;
    this.tokens = Math.min(this.policy.capacity, this.tokens + tokensToAdd);
    this.lastRefillMs = current;
  }
}

export class TenantRateLimiter {
  private buckets = new Map<string, TenantTokenBucket>();
  private defaultPolicy: TenantRateLimitPolicy;
  private tierPolicies: Record<1 | 2 | 3, TenantRateLimitPolicy>;
  private tenantPolicies: Record<string, TenantRateLimitPolicy>;
  private now: () => number;

  constructor(options: TenantRateLimitOptions = {}) {
    this.defaultPolicy = options.defaultPolicy ?? DEFAULT_TENANT_POLICY;
    this.tierPolicies = { ...DEFAULT_TIER_POLICIES, ...options.tierPolicies };
    this.tenantPolicies = options.tenantPolicies ?? {};
    this.now = options.now ?? Date.now;
  }

  allow(tenant: TenantContext, cost = 1): { allowed: boolean; retryAfterSeconds: number; remainingTokens: number } {
    const policy = this.policyFor(tenant);
    let bucket = this.buckets.get(tenant.tenantId);
    if (!bucket) {
      bucket = new TenantTokenBucket(policy, this.now);
      this.buckets.set(tenant.tenantId, bucket);
    } else {
      bucket.updatePolicy(policy);
    }

    const allowed = bucket.consume(cost);
    const snapshot = bucket.snapshot();
    tenantBucketTokensGauge.set({ tenant_id: tenant.tenantId, tier: String(tenant.tier) }, snapshot.tokens);
    tenantRateLimitDecisionsTotal.inc({ tenant_id: tenant.tenantId, tier: String(tenant.tier), decision: allowed ? 'allow' : 'throttle' });
    if (!allowed) tenantRateLimitThrottledTotal.inc({ tenant_id: tenant.tenantId, tier: String(tenant.tier) });

    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : bucket.retryAfterSeconds(cost),
      remainingTokens: Math.floor(snapshot.tokens),
    };
  }

  bucketCount(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
  }

  private policyFor(tenant: TenantContext): TenantRateLimitPolicy {
    return this.tenantPolicies[tenant.tenantId] ?? this.tierPolicies[tenant.tier] ?? this.defaultPolicy;
  }
}

function getOrCreateMetric<T>(name: string, factory: () => T): T {
  return (metricsRegistry.getSingleMetric(name) as T | undefined) ?? factory();
}

export const tenantRateLimitDurationMs = getOrCreateMetric(
  'tenant_rate_limit_check_duration_ms',
  () => new Histogram({
    name: 'tenant_rate_limit_check_duration_ms',
    help: 'Per-tenant token bucket decision latency in milliseconds',
    labelNames: ['tier', 'decision'] as const,
    buckets: [1, 5, 10, 25, 50, 100],
    registers: [metricsRegistry],
  }),
) as Histogram<'tier' | 'decision'>;

export const tenantRateLimitDecisionsTotal = getOrCreateMetric(
  'tenant_rate_limit_decisions_total',
  () => new Counter({
    name: 'tenant_rate_limit_decisions_total',
    help: 'Per-tenant rate-limit decisions by tenant, tier, and decision',
    labelNames: ['tenant_id', 'tier', 'decision'] as const,
    registers: [metricsRegistry],
  }),
) as Counter<'tenant_id' | 'tier' | 'decision'>;

export const tenantRateLimitThrottledTotal = getOrCreateMetric(
  'tenant_rate_limit_throttled_total',
  () => new Counter({
    name: 'tenant_rate_limit_throttled_total',
    help: 'Per-tenant requests rejected by token bucket rate limiting',
    labelNames: ['tenant_id', 'tier'] as const,
    registers: [metricsRegistry],
  }),
) as Counter<'tenant_id' | 'tier'>;

export const tenantBucketTokensGauge = getOrCreateMetric(
  'tenant_rate_limit_bucket_tokens',
  () => new Gauge({
    name: 'tenant_rate_limit_bucket_tokens',
    help: 'Current token count in each tenant token bucket',
    labelNames: ['tenant_id', 'tier'] as const,
    registers: [metricsRegistry],
  }),
) as Gauge<'tenant_id' | 'tier'>;

export function resolveTenantContext(req: Request, tenantIdHeader = 'x-tenant-id'): TenantContext {
  const existing = (req as Request & { tenantContext?: TenantContext }).tenantContext;
  if (existing?.tenantId) return existing;

  const headerTenant = req.header(tenantIdHeader);
  return { tenantId: headerTenant?.trim() || 'anonymous', tier: 3 };
}

export function createTenantRateLimitMiddleware(
  limiter = new TenantRateLimiter(),
  options: Pick<TenantRateLimitOptions, 'tenantIdHeader'> = {},
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    const tenant = resolveTenantContext(req, options.tenantIdHeader);
    const decision = limiter.allow(tenant);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    tenantRateLimitDurationMs.observe({ tier: String(tenant.tier), decision: decision.allowed ? 'allow' : 'throttle' }, elapsedMs);

    res.setHeader('X-RateLimit-Remaining', String(decision.remainingTokens));
    if (decision.allowed) return next();

    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    return res.status(429).json({
      error: 'rate_limit_exceeded',
      message: 'Per-tenant request rate limit exceeded',
      tenantId: tenant.tenantId,
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  };
}

export default createTenantRateLimitMiddleware;
