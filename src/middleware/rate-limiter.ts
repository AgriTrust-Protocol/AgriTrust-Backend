import { NextFunction, Request, Response } from 'express';
import { Counter, Gauge } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';
import { certificateIssuanceRateLimit } from '../config/rate-limits';
import { AdaptiveController } from '../limiter/adaptive-controller';
import { SlidingWindowCounter } from '../limiter/sliding-window-counter';

const remainingGauge = new Gauge({
  name: 'rate_limit_remaining',
  help: 'Remaining requests in the active sliding window',
  labelNames: ['tenant_id', 'scope'] as const,
  registers: [metricsRegistry],
});

const blockedCounter = new Counter({
  name: 'rate_limit_blocked_total',
  help: 'Total requests blocked by the adaptive rate limiter',
  labelNames: ['tenant_id', 'scope'] as const,
  registers: [metricsRegistry],
});

export interface RateLimiterMiddlewareOptions {
  counter: SlidingWindowCounter;
  adaptiveController: Pick<AdaptiveController, 'getCurrentMax'>;
  scope?: string;
  tenantKeyPrefix?: string;
  cost?: number | ((req: Request) => number);
  tenantResolver?: (req: Request) => string;
}

export function createRateLimiterMiddleware(options: RateLimiterMiddlewareOptions) {
  const scope = options.scope ?? 'certificate_issuance';
  const tenantKeyPrefix = options.tenantKeyPrefix ?? certificateIssuanceRateLimit.tenantKeyPrefix;

  return async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = options.tenantResolver?.(req) ?? resolveTenantId(req);
      const cost = typeof options.cost === 'function' ? options.cost(req) : options.cost ?? 1;
      const limit = options.adaptiveController.getCurrentMax();
      const key = `${tenantKeyPrefix}:${tenantId}`;
      const decision = await options.counter.allow(key, limit, cost);

      remainingGauge.set({ tenant_id: tenantId, scope }, decision.remaining);

      res.setHeader('X-RateLimit-Limit', String(decision.limit));
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining));

      if (!decision.allowed) {
        blockedCounter.inc({ tenant_id: tenantId, scope });
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        res.status(429).json({
          error: 'rate_limit_exceeded',
          message: 'Certificate issuance rate limit exceeded',
          retryAfterSeconds: decision.retryAfterSeconds,
        });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function resolveTenantId(req: Request): string {
  const header = req.header('x-tenant-id');
  if (header?.trim()) return header.trim();
  const authTenant = (req as Request & { tenantId?: string }).tenantId;
  if (authTenant) return authTenant;
  return req.ip ?? 'unknown';
}
