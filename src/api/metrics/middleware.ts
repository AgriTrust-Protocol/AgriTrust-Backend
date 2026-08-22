/**
 * AgriTrust Backend – HTTP Metrics Middleware
 *
 * Express middleware that records per-route:
 *   - Request duration (Histogram)
 *   - Response size bytes (Histogram)
 *   - Response status code (Counter)
 *
 * Route patterns are normalised by Express before reaching this middleware,
 * so `/users/123` becomes `/users/:id` in the label set.  This keeps
 * cardinality bounded (issue requirement: no unbounded label combinations).
 *
 * Buckets match the issue specification:
 *   [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0] seconds
 *
 * Usage:
 *   import { metricsMiddleware } from './api/metrics/middleware';
 *   app.use(metricsMiddleware);
 */

import { Request, Response, NextFunction } from 'express';
import { Histogram, Counter } from 'prom-client';
import { metricsRegistry } from './registry';
import { traceContextFrom, observeWithExemplar } from './exemplars';

// ─── Prometheus Metrics ─────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds per route',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
  registers: [metricsRegistry],
});

export const httpResponseSize = new Histogram({
  name: 'http_response_size_bytes',
  help: 'HTTP response body size in bytes per route',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000],
  registers: [metricsRegistry],
});

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests per route and status code',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Express middleware that captures request duration, response size,
 * and status code for every request.
 *
 * The route label is derived from `req.route?.path` (Express normalises
 * params to `:param` placeholders), falling back to `req.path` for
 * unmatched routes (e.g. 404s).
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  // Capture the original end() to intercept the response
  const originalEnd = res.end;
  let responseBodyBytes = 0;

  res.end = function (this: Response, ...args: Parameters<typeof originalEnd>): Response {
    // Calculate duration
    const end = process.hrtime.bigint();
    const durationNs = Number(end - start);
    const durationSec = durationNs / 1e9;

    // Derive route label — use Express's normalised pattern or fall back to path
    const route: string = (req as any).route?.path ?? req.path ?? 'unknown';

    const method = req.method;
    const statusCode = String(res.statusCode);

    // Track response body size from the arguments passed to res.end()
    if (args[0] && typeof args[0] === 'string') {
      responseBodyBytes = Buffer.byteLength(args[0], 'utf-8');
    } else if (args[0] && Buffer.isBuffer(args[0])) {
      responseBodyBytes = args[0].length;
    }

    // Observe metrics with exemplar support (trace_id linked when available)
    const traceCtx = traceContextFrom(req);
    observeWithExemplar(httpRequestDuration, durationSec, traceCtx, {
      method,
      route,
      status_code: statusCode,
    });
    observeWithExemplar(httpResponseSize, responseBodyBytes, traceCtx, {
      method,
      route,
      status_code: statusCode,
    });
    httpRequestsTotal.inc({ method, route, status_code: statusCode });

    // Call the original end()
    return originalEnd.apply(this, args);
  } as typeof originalEnd;

  next();
}
