import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { InMemoryTenantRegistry, TenantResolver } from '../../src/gateway/tenant_resolver';
import { createTenantRoutingMiddleware } from '../../src/gateway/router';
import { extractTenantIdentity } from '../../src/gateway/tls_terminator';

function certFor(farmId: string, tenantId: string, role = 'farm') {
  return {
    subject: { CN: `${farmId}.agritrust.io` },
    subjectaltname: `URI:farm_id:${farmId}, URI:tenant_id:${tenantId}, URI:role:${role}`,
    valid_to: new Date(Date.now() + 86_400_000).toUTCString(),
    raw: Buffer.from(`${farmId}:${tenantId}`),
  } as any;
}

describe('gateway tenant routing', () => {
  it('routes 10 client certificates to isolated tenant schemas', async () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      farmId: `farm-${i}`,
      tenantId: `tenant-${i}`,
      schemaName: `tenant_${i}`,
      roles: ['farm'],
    }));
    const resolver = new TenantResolver(new InMemoryTenantRegistry(records));
    const app = express();
    app.use(async (req, _res, next) => {
      const index = Number(req.header('x-test-cert-index'));
      (req as any).tenantContext = await resolver.resolve(extractTenantIdentity(certFor(`farm-${index}`, `tenant-${index}`)));
      next();
    });
    app.use(createTenantRoutingMiddleware());
    app.get('/settlements', (req, res) => {
      res.json({ tenantId: req.header('x-tenant-id'), schema: req.header('x-tenant-schema') });
    });

    for (let i = 0; i < 10; i += 1) {
      const response = await request(app).get('/settlements').set('x-test-cert-index', String(i)).expect(200);
      expect(response.body).toEqual({ tenantId: `tenant-${i}`, schema: `tenant_${i}` });
      expect(response.headers['x-tenant-id']).toBe(`tenant-${i}`);
      expect(response.headers['x-tenant-schema']).toBe(`tenant_${i}`);
    }
  });

  it('applies the 10000 req/min aggregator bucket policy', async () => {
    const resolver = new TenantResolver(new InMemoryTenantRegistry([
      { farmId: 'co-op', tenantId: 'tenant-agg', schemaName: 'tenant_agg', roles: ['aggregator'] },
    ]));
    const tenant = await resolver.resolve(extractTenantIdentity(certFor('co-op', 'tenant-agg', 'aggregator')));
    expect(tenant.rateLimitClass).toBe('aggregator');
  });
});
