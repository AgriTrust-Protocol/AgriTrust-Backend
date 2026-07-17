import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';

export const traceContextPropagationTotal = new Counter({
  name: 'trace_context_propagation_total',
  help: 'Trace context extraction and injection outcomes by direction and result',
  labelNames: ['direction', 'result'] as const,
  registers: [metricsRegistry],
});

export const traceSpanDuration = new Histogram({
  name: 'trace_span_duration_seconds',
  help: 'Server span duration observed by the tracing middleware',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});
