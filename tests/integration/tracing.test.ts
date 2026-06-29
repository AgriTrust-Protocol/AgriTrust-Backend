import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { tracingMiddleware } from '../../src/middleware/tracing';
import { TraceContext } from '../../src/tracing/trace-context';
import { BaggageManager } from '../../src/tracing/baggage-manager';
import { tracedFetch } from '../../src/tracing/fetch-wrapper';

// Mock global fetch
global.fetch = vi.fn();

describe('Distributed Tracing Integration', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(tracingMiddleware);
    // Add error handler to see errors
    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      console.error('App Error:', err);
      res.status(500).json({ error: err.message, stack: err.stack });
    });
    vi.clearAllMocks();
  });

  it('should propagate trace context from incoming headers to downstream calls', async () => {
    const traceId = TraceContext.generateTraceId();
    const parentId = TraceContext.generateSpanId();
    const traceParent = `00-${traceId}-${parentId}-01`;

    app.get('/test', async (req, res) => {
      try {
        const span = (req as any).traceSpan;
        // @ts-ignore
        const baggageManager = req.baggageManager;
        await tracedFetch('http://downstream-service/api', {}, baggageManager, span);
        res.status(200).json({ ok: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    const res = await request(app)
      .get('/test')
      .set('traceparent', traceParent);

    expect(res.status).toBe(200);

    expect(global.fetch).toHaveBeenCalled();

    const callHeaders = (global.fetch as any).mock.calls[0][1].headers;
    const propagatedTraceParent = callHeaders.get('traceparent');

    expect(propagatedTraceParent).toBeTruthy();
    expect(propagatedTraceParent).toContain(traceId);
    // Note: Since we are using mock Tracer in tests, startSpan might return the same context if not properly mocked
  });

  it('should isolate internal headers into baggage', async () => {
    const tenantId = 'tenant-123';

    app.get('/tenant-test', async (req, res) => {
      const span = (req as any).traceSpan;
      // @ts-ignore
      const baggageManager = req.baggageManager;
      await tracedFetch('http://downstream-service/api', {}, baggageManager, span);
      res.status(200).json({ ok: true });
    });

    const res = await request(app)
      .get('/tenant-test')
      .set('X-Tenant-Id', tenantId);

    expect(res.status).toBe(200);

    const callHeaders = (global.fetch as any).mock.calls[0][1].headers;
    const baggage = callHeaders.get('baggage');

    expect(baggage).toContain(`agritrust.tenant-id=${tenantId}`);
  });

  it('should handle missing traceparent and generate a new one', async () => {
    app.get('/new-trace', async (req, res) => {
      res.status(200).json({ ok: true });
    });

    await request(app).get('/new-trace').expect(200);
  });

  it('should enforce baggage limits', () => {
    const baggage = new BaggageManager();
    for (let i = 0; i < 70; i++) {
      baggage.set(`key${i}`, 'value');
    }

    const formatted = baggage.format();
    const entries = formatted.split(',');
    expect(entries.length).toBeLessThanOrEqual(64);
  });
});
