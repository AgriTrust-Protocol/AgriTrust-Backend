import { NextFunction, Request, Response } from 'express';
import { TenantTokenBucketLimiter } from './rate_limiter';
import { ResolvedTenant } from './tenant_resolver';

export interface TenantRequest extends Request { tenantContext?: ResolvedTenant; }

export function createTenantRoutingMiddleware(limiter = new TenantTokenBucketLimiter()) {
  return (req: TenantRequest, res: Response, next: NextFunction): void => {
    const tenant = req.tenantContext;
    if (!tenant) {
      res.status(401).json({ error: 'tenant_context_required' });
      return;
    }
    const decision = limiter.allow(tenant.tenantId, tenant.rateLimitClass);
    res.setHeader('X-RateLimit-Limit', String(decision.limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.status(429).json({ error: 'rate_limit_exceeded' });
      return;
    }
    req.headers['x-tenant-id'] = tenant.tenantId;
    req.headers['x-tenant-schema'] = tenant.schemaName;
    res.setHeader('X-Tenant-Id', tenant.tenantId);
    res.setHeader('X-Tenant-Schema', tenant.schemaName);
    next();
  };
}
