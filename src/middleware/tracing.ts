import { Request, Response, NextFunction } from 'express';
import { TraceContext } from '../tracing/trace-context';
import { BaggageManager } from '../tracing/baggage-manager';
import { DeterministicSampler } from '../tracing/sampler';
import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { tracingConfig } from '../config/tracing';

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
        traceId = parsed.traceId;
        parentSpanId = parsed.parentId;
        flags = parseInt(parsed.traceFlags, 16);
      } else {
        traceId = TraceContext.generateTraceId();
      }
    } else {
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

    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      if (res.statusCode >= 400) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    });

    // Store in context for downstream
    const newContext = trace.setSpan(parentCtx, span);
    context.with(newContext, () => {
      next();
    });
  } catch (err) {
    console.error('Error in tracing middleware:', err);
    next(err);
  }
}
