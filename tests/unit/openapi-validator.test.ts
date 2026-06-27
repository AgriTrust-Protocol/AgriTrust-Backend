import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openApiConfig } from '../../src/config/openapi';
import { versionResolver } from '../../src/middleware/version-resolver';
import { openApiValidationMiddleware } from '../../src/middleware/openapi-validator';
import { getMergedOpenApiDocument } from '../../src/openapi/spec-loader';

beforeAll(async () => {
  await getMergedOpenApiDocument();
});

describe('OpenAPI contract validation middleware', () => {
  function buildApp(mode: 'strict' | 'warning' | 'off') {
    const app = express();
    app.use(express.json());
    openApiConfig.mode = mode;
    app.use(versionResolver);
    app.use(openApiValidationMiddleware);

    app.post('/api/v1/batches/:id/certify', (req, res) => {
      if (req.body.invalidResponse) {
        return res.status(200).json({ unexpected: true });
      }

      return res.status(200).json({ message: 'Certificate minted successfully', certificate_id: 'cert-123' });
    });

    app.get('/openapi.json', async (req, res) => {
      const doc = await getMergedOpenApiDocument(req.apiVersion);
      return res.status(200).json(doc);
    });

    return app;
  }

  it('rejects invalid request bodies with 400 in strict mode', async () => {
    const app = buildApp('strict');

    const response = await request(app)
      .post('/api/v1/batches/abc123/certify')
      .set('X-API-Version', 'v1')
      .send({ metadata: { source: 123 } })
      .expect(400);

    expect(response.body).toMatchObject({
      type: expect.stringContaining('openapi-request-validation'),
      title: 'Request validation failed',
      status: 400,
      instance: '/api/v1/batches/abc123/certify',
    });
    expect(response.body.errors?.[0]).toHaveProperty('message');
    expect(response.headers['x-opencode-validation-error']).toBe('true');
  });

  it('logs warnings and continues in warning mode for invalid requests', async () => {
    const app = buildApp('warning');

    const response = await request(app)
      .post('/api/v1/batches/abc123/certify')
      .set('X-API-Version', 'v1')
      .send({ metadata: { source: 'BadSource' } })
      .expect(200);

    expect(response.headers['x-opencode-validation-warning']).toBe('true');
    expect(response.body).toMatchObject({ message: 'Certificate minted successfully', certificate_id: 'cert-123' });
  });

  it('skips validation in off mode', async () => {
    const app = buildApp('off');

    const response = await request(app)
      .post('/api/v1/batches/abc123/certify')
      .set('X-API-Version', 'v1')
      .send({ metadata: { source: 123 } })
      .expect(200);

    expect(response.headers['x-opencode-validation-warning']).toBeUndefined();
    expect(response.headers['x-opencode-validation-error']).toBeUndefined();
    expect(response.body).toMatchObject({ message: 'Certificate minted successfully', certificate_id: 'cert-123' });
  });

  it('returns 500 when an outbound response violates the OpenAPI response schema in strict mode', async () => {
    const app = buildApp('strict');

    const response = await request(app)
      .post('/api/v1/batches/abc123/certify')
      .set('X-API-Version', 'v1')
      .send({ invalidResponse: true })
      .expect(500);

    expect(response.body).toMatchObject({
      type: expect.stringContaining('openapi-response-validation'),
      title: 'Response validation failed',
      status: 500,
      instance: '/api/v1/batches/abc123/certify',
    });
    expect(response.headers['x-opencode-validation-error']).toBe('true');
    expect(response.headers['x-internal-error']).toBe('true');
  });

  it('serves the merged OpenAPI spec at /openapi.json', async () => {
    const app = buildApp('strict');
    const response = await request(app).get('/openapi.json').set('X-API-Version', 'v1').expect(200);
    expect(response.body).toHaveProperty('openapi', '3.1.0');
    expect(response.body.paths).toHaveProperty('/api/v1/batches/{id}/certify');
  });
});
