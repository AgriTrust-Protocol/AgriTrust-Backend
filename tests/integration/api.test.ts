import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mock dependencies before importing the app
vi.mock('pg', () => {
  const mPool = {
    query: vi.fn().mockResolvedValue({ rows: [{ count: 0 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  };
  return { 
    Pool: class {
      query = mPool.query;
      end = mPool.end;
      on = vi.fn();
    }
  };
});

vi.mock('ioredis', () => {
  const mRedis = {
    on: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    quit: vi.fn(),
  };
  return { default: vi.fn(() => mRedis) };
});

vi.mock('../../src/config/loader', () => ({
  configLoader: { load: vi.fn(), startHotReload: vi.fn() }
}));

vi.mock('../../src/config/config-monitoring', () => ({
  collectConfigMetrics: vi.fn()
}));

// @ts-ignore
import app from '../../index.js';

describe('API Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET / should return basic info', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('project', 'Grant Stream');
  });

  it('GET /health/ledger-consistency should return consistency status', async () => {
    const res = await request(app).get('/health/ledger-consistency');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('healthy');
  });

  it('GET /api/versions should return version registry', async () => {
    const res = await request(app).get('/api/versions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('versions');
  });

  it('GET /openapi.json should return OpenAPI document', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('openapi');
  });
});
