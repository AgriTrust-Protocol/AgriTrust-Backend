import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace, SpanKind } from '@opentelemetry/api';
import { tracingMiddleware } from '../../src/middleware/tracing';

// Mock OTLP receiver: an in-memory exporter standing in for the OpenTelemetry
// Collector, so we can assert what would be exported without a live collector.
const memoryExporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

beforeAll(() => {
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
  });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  memoryExporter.reset();
});

describe('OpenTelemetry span export (issue #177)', () => {
  it('exports a trace with at least 3 spans through the instrumented stack', async () => {
    const app = express();
    app.use(tracingMiddleware);
    app.get('/api/settlements/:id', async (_req: Request, res: Response) => {
      const tracer = trace.getTracer('test');
      // Stands in for the DB span @opentelemetry/instrumentation-pg emits.
      await tracer.startActiveSpan('pg.query', async (s) => s.end());
      // The manual Soroban RPC span (see tracedSorobanFetch in soroban_bridge).
      await tracer.startActiveSpan('soroban_rpc_call', { kind: SpanKind.CLIENT }, async (s) => s.end());
      res.status(200).json({ ok: true });
    });

    await request(app).get('/api/settlements/abc').expect(200);
    // Let the res 'finish' handler end the server span.
    await new Promise((r) => setTimeout(r, 25));

    const spans = memoryExporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(3);

    const names = spans.map((s) => s.name);
    expect(names).toContain('soroban_rpc_call');
    expect(names).toContain('pg.query');
    // The middleware's server span for the request.
    expect(names.some((n) => n.includes('/api/settlements'))).toBe(true);
  });

  it('samples a settlement route at 100% (server span carries the sampled flag)', async () => {
    const app = express();
    app.use(tracingMiddleware);
    app.get('/api/settlements/:id', (_req, res) => res.status(200).end());

    await request(app).get('/api/settlements/xyz').expect(200);
    await new Promise((r) => setTimeout(r, 25));

    const serverSpan = memoryExporter
      .getFinishedSpans()
      .find((s) => s.name.includes('/api/settlements'));
    expect(serverSpan).toBeDefined();
    expect(serverSpan!.attributes['agritrust.sampling_probability']).toBe(1);
  });
});
