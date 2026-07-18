import { Request, Response, NextFunction } from 'express';
import { TraceContext } from '../tracing/trace-context';
import { BaggageManager } from '../tracing/baggage-manager';
import { DeterministicSampler } from '../tracing/sampler';
import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { tracingConfig } from '../config/tracing';
import { traceContextPropagationTotal, traceSpanDuration } from '../tracing/metrics';
import { logger } from '../logging/structured-logger';

const sampler = new DeterministicSampler(tracingConfig.samplingProbability);

export function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const traceParentHeader = req.header('traceparent');
    const baggageHeader = req.header('baggage');

    let traceId: string;
    let parentSpanId: string | undefined;
    let flags = 0;

    if (traceParentHeader) {
      const parsed = TraceContext.parseTraceParent(traceParentHeader);
      if (parsed) {
        traceContextPropagationTotal.inc({ direction: 'incoming', result: 'accepted' });
        traceId = parsed.traceId;
        parentSpanId = parsed.parentId;
        flags = parseInt(parsed.traceFlags, 16);
      } else {
        traceContextPropagationTotal.inc({ direction: 'incoming', result: 'rejected' });
        traceId = TraceContext.generateTraceId();
      }
    } else {
      traceContextPropagationTotal.inc({ direction: 'incoming', result: 'created' });
      traceId = TraceContext.generateTraceId();
    }

    // Head-based sampling decision if not already sampled by parent
    const shouldSample = sampler.shouldSample(traceId);
    if (shouldSample) {
      flags = flags | 1;
    }

    const baggageManager = new BaggageManager(baggageHeader);

    // Isolate internal headers
    const internalHeaders = ['x-tenant-id', 'x-batch-id'];
    for (const headerName of internalHeaders) {
      const value = req.header(headerName);
      if (value) {
        const baggageKey = BaggageManager.isolateInternalHeader(headerName);
        baggageManager.set(baggageKey, value);
      }
    }

    const spanName = `${req.method} ${req.path}`;
    const spanStart = process.hrtime.bigint();
    const tracer = trace.getTracer('agritrust-middleware');

    // Manually construct parent context if it exists
    let parentCtx = context.active();
    if (traceId && parentSpanId) {
      const spanContext = {
        traceId,
        spanId: parentSpanId,
        traceFlags: flags,
        isRemote: true
      };
      parentCtx = trace.setSpanContext(parentCtx, spanContext);
    }

    // Create span
    const span = tracer.startSpan(spanName, {
      kind: SpanKind.SERVER,
      attributes: {
        'http.method': req.method,
        'http.url': req.url,
        'agritrust.tenant_id': baggageManager.get('agritrust.tenant-id') || req.header('x-tenant-id'),
        'agritrust.batch_id': baggageManager.get('agritrust.batch-id') || req.header('x-batch-id'),
      },
    }, parentCtx);

    (req as any).baggageManager = baggageManager;
    (req as any).traceSpan = span;

    const startTime = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      span.setAttribute('http.status_code', res.statusCode);
      if (res.statusCode >= 400) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      const route = (req as any).route?.path ?? req.path ?? 'unknown';
      const durationSec = Number(process.hrtime.bigint() - spanStart) / 1e9;
      traceSpanDuration.observe({ method: req.method, route, status_code: String(res.statusCode) }, durationSec);
      logger.info('http.server.request.completed', {
        'http.request.method': req.method,
        'url.path': req.path,
        'url.query': req.query && Object.keys(req.query).length > 0 ? JSON.stringify(req.query) : undefined,
        'http.route': req.route?.path,
        'http.response.status_code': res.statusCode,
        'client.address': req.ip,
        'user_agent.original': req.header('user-agent'),
        'server.address': req.hostname,
        'network.protocol.version': req.httpVersion,
        'http.server.request.duration_ms': Number(durationMs.toFixed(3)),
        'agritrust.tenant_id': baggageManager.get('agritrust.tenant-id') || req.header('x-tenant-id'),
        'agritrust.batch_id': baggageManager.get('agritrust.batch-id') || req.header('x-batch-id'),
      });
      span.end();
    });

    // Store in context for downstream
    const newContext = trace.setSpan(parentCtx, span);
    context.with(newContext, () => {
      next();
    });
  } catch (err) {
    logger.error('tracing.middleware.error', err);
    next(err);
  }
}
