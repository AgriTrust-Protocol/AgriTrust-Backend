import { trace, context, Span, SpanContext } from '@opentelemetry/api';
import { TraceContext, TraceParent } from './trace-context';
import { BaggageManager } from './baggage-manager';

export async function tracedFetch(
  url: string,
  options: RequestInit = {},
  baggageManager?: BaggageManager,
  explicitSpan?: Span
): Promise<Response> {
  const span = explicitSpan || trace.getSpan(context.active());
  const headers = new Headers(options.headers || {});

  if (span) {
    const ctx = span.spanContext();
    const traceParent: TraceParent = {
      version: '00',
      traceId: ctx.traceId,
      parentId: ctx.spanId,
      traceFlags: ctx.traceFlags.toString(16).padStart(2, '0'),
    };
    headers.set('traceparent', TraceContext.formatTraceParent(traceParent));

    // Propagate tracestate if it exists in the span context or elsewhere
    // Since OTel SpanContext might have traceState, we should use it
    if ((ctx as any).traceState) {
      const ts = (ctx as any).traceState.serialize();
      if (ts) {
        headers.set('tracestate', ts);
      }
    }
  }

  if (baggageManager) {
    const baggageHeader = baggageManager.format();
    if (baggageHeader) {
      headers.set('baggage', baggageHeader);
    }
  }

  return fetch(url, { ...options, headers });
}

/**
 * Global fetch wrapper to simplify adoption.
 */
export function wrapGlobalFetch() {
  const originalFetch = global.fetch;
  global.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const span = trace.getSpan(context.active());
    const headers = new Headers(init?.headers || {});

    if (span) {
      const ctx = span.spanContext();
      const traceParent: TraceParent = {
        version: '00',
        traceId: ctx.traceId,
        parentId: ctx.spanId,
        traceFlags: ctx.traceFlags.toString(16).padStart(2, '0'),
      };
      headers.set('traceparent', TraceContext.formatTraceParent(traceParent));

      if ((ctx as any).traceState) {
        const ts = (ctx as any).traceState.serialize();
        if (ts) {
          headers.set('tracestate', ts);
        }
      }
    }

    return originalFetch(input, { ...init, headers });
  };
}
