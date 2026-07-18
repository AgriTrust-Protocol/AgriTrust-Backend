import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  createTenantRateLimitMiddleware,
  TenantRateLimiter,
  TenantTokenBucket,
} from '../../src/api/middleware/tenant_rate_limit';

describe('TenantTokenBucket', () => {
  it('enforces capacity and refills over time', () => {
    let now = 0;
    const bucket = new TenantTokenBucket({ capacity: 2, refillRatePerMinute: 60 }, () => now);

    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(false);

    now += 1_000;
    expect(bucket.consume()).toBe(true);
  });
});

describe('TenantRateLimiter', () => {
  it('isolates token buckets per tenant', () => {
    const limiter = new TenantRateLimiter({ tierPolicies: { 3: { capacity: 1, refillRatePerMinute: 1 } } });

    expect(limiter.allow({ tenantId: 'tenant-a', tier: 3 }).allowed).toBe(true);
    expect(limiter.allow({ tenantId: 'tenant-a', tier: 3 }).allowed).toBe(false);
    expect(limiter.allow({ tenantId: 'tenant-b', tier: 3 }).allowed).toBe(true);
  });

  it('applies tenant-specific overrides before tier defaults', () => {
    const limiter = new TenantRateLimiter({
      tierPolicies: { 1: { capacity: 1, refillRatePerMinute: 1 } },
      tenantPolicies: { vip: { capacity: 2, refillRatePerMinute: 1 } },
    });

    expect(limiter.allow({ tenantId: 'vip', tier: 1 }).allowed).toBe(true);
    expect(limiter.allow({ tenantId: 'vip', tier: 1 }).allowed).toBe(true);
    expect(limiter.allow({ tenantId: 'vip', tier: 1 }).allowed).toBe(false);
  });
});

describe('createTenantRateLimitMiddleware', () => {
  it('returns 429 with retry metadata when a tenant exceeds its bucket', async () => {
    const limiter = new TenantRateLimiter({ tierPolicies: { 3: { capacity: 1, refillRatePerMinute: 60 } } });
    const app = express();
    app.use(createTenantRateLimitMiddleware(limiter));
    app.get('/ok', (_req, res) => res.json({ ok: true }));

    await request(app).get('/ok').set('X-Tenant-Id', 'tenant-a').expect(200);
    const throttled = await request(app).get('/ok').set('X-Tenant-Id', 'tenant-a').expect(429);

    expect(throttled.headers['retry-after']).toBe('1');
    expect(throttled.body.error).toBe('rate_limit_exceeded');
  });

  it('uses authenticated tenant context when auth middleware has resolved it', async () => {
    const limiter = new TenantRateLimiter({
      tierPolicies: { 1: { capacity: 2, refillRatePerMinute: 1 }, 3: { capacity: 1, refillRatePerMinute: 1 } },
    });
    const app = express();
    app.use((req, _res, next) => {
      (req as typeof req & { tenantContext?: { tenantId: string; tier: 1 | 2 | 3 } }).tenantContext = { tenantId: 'auth-tenant', tier: 1 };
      next();
    });
    app.use(createTenantRateLimitMiddleware(limiter));
    app.get('/ok', (_req, res) => res.json({ ok: true }));

    await request(app).get('/ok').set('X-Tenant-Id', 'ignored-header').expect(200);
    await request(app).get('/ok').set('X-Tenant-Id', 'ignored-header').expect(200);
    await request(app).get('/ok').set('X-Tenant-Id', 'ignored-header').expect(429);
  });
});
