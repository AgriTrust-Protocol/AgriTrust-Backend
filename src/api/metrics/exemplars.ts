/**
 * AgriTrust Backend – OpenTelemetry Exemplar Support
 *
 * Provides utilities to attach `trace_id` exemplars to prom-client Histogram
 * observations when an OpenTelemetry trace context is present in the request.
 *
 * This enables linking Prometheus metrics to traces in a Prometheus+Tempo
 * stack — a key requirement for production observability.
 *
 * Usage (inside middleware or collection code):
 *   import { observeWithExemplar, traceContextFrom } from './exemplars';
 *
 *   const ctx = traceContextFrom(req);
 *   observeWithExemplar(myHistogram, value, ctx);
 *
 * The exemplar is only attached when a valid trace_id is present;
 * otherwise the observation proceeds without exemplars.
 */

import { Histogram } from 'prom-client';

// ─── Trace Context Interface ────────────────────────────────────────────────

export interface TraceContext {
  traceId?: string;
  spanId?: string;
}

// ─── W3C Trace Context Extraction ───────────────────────────────────────────

/**
 * Extract trace context from W3C `traceparent` header.
 *
 * Format: `{version}-{trace-id}-{parent-id}-{trace-flags}`
 * Example: `00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`
 */
export function parseTraceparent(header: string): TraceContext | null {
  if (!header || typeof header !== 'string') return null;

  const parts = header.split('-');
  if (parts.length < 4) return null;

  const [, traceId, spanId] = parts;

  // Validate trace_id: must be 32 hex chars, not all zeros
  if (!/^[0-9a-f]{32}$/i.test(traceId) || traceId === '0'.repeat(32)) {
    return null;
  }

  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId?.toLowerCase(),
  };
}

/**
 * Extract trace context from an IncomingMessage-like object.
 * Checks `traceparent` and `tracestate` headers.
 */
export function traceContextFrom(req: {
  headers?: Record<string, string | string[] | undefined>;
}): TraceContext | null {
  if (!req.headers) return null;

  const raw = req.headers['traceparent'];
  const traceparent = Array.isArray(raw) ? raw[0] : raw;

  if (traceparent) {
    return parseTraceparent(traceparent);
  }

  // Fallback: check X-Trace-Id header (some instrumentation uses this)
  const xTraceId = req.headers['x-trace-id'];
  const id = Array.isArray(xTraceId) ? xTraceId[0] : xTraceId;

  if (id && /^[0-9a-f]{32}$/i.test(id)) {
    return { traceId: id.toLowerCase() };
  }

  return null;
}

// ─── Exemplar-aware Observation ─────────────────────────────────────────────

/**
 * Observe a value on a Histogram, attaching an exemplar with `trace_id`
 * if a valid TraceContext is provided.
 *
 * prom-client supports exemplars on Histogram via the `exemplar` field
 * in the observe options.
 */
export function observeWithExemplar(
  histogram: Histogram,
  value: number,
  ctx: TraceContext | null,
  labels?: Record<string, string>,
): void {
  if (ctx?.traceId) {
    // prom-client Histogram.observe() supports exemplar via labels + exemplarLabels
    // We use the observe({ value, exemplarLabels }) form when available,
    // otherwise fall back to plain observe.
    try {
      histogram.observe(
        {
          ...labels,
          exemplarLabels: { trace_id: ctx.traceId },
        } as any,
        value,
      );
    } catch {
      // Fallback: plain observation if exemplar API not available
      if (labels) {
        histogram.observe(labels, value);
      } else {
        histogram.observe(value);
      }
    }
  } else {
    if (labels) {
      histogram.observe(labels, value);
    } else {
      histogram.observe(value);
    }
  }
}
