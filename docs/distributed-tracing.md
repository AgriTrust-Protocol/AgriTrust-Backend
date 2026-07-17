# Distributed tracing architecture

AgriTrust uses OpenTelemetry for request-scoped distributed tracing and W3C Trace Context propagation across HTTP service boundaries.

## Request lifecycle

1. `tracingMiddleware` reads `traceparent`, `tracestate`, and `baggage` from inbound requests.
2. Valid parent trace context is accepted; invalid context is rejected and replaced with a new trace id.
3. A deterministic head sampler applies `TRACING_SAMPLING_PROBABILITY` while preserving sampled parent decisions.
4. Internal routing headers such as `X-Tenant-Id` and `X-Batch-Id` are isolated under the `agritrust.` baggage namespace before propagation.
5. Downstream HTTP calls made with `tracedFetch` or `wrapGlobalFetch` inject `traceparent`, `tracestate`, and bounded baggage.
6. The OpenTelemetry SDK exports spans to the configured OTLP collector endpoint.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRACING_SAMPLING_PROBABILITY` | `0.8` | Head-sampling probability for newly-created traces. |
| `OTEL_COLLECTOR_ENDPOINT` | `localhost:4317` | OTLP/gRPC collector endpoint. |
| `OTEL_BATCH_INTERVAL_MS` | `5000` | Batch span processor flush interval. |

## Performance and security controls

- Baggage is capped at 64 entries, 512 bytes per value, and 8 KiB total to protect P99 latency and header budgets.
- Trace-context labels use bounded dimensions only: direction, result, method, route, and status code.
- Tenant and batch identifiers are propagated only through the `agritrust.` baggage namespace.
- The tracing middleware records span duration metrics against the 100 ms critical-path target.

## Deployment strategy

1. Deploy the tracing-enabled build to the blue environment with `TRACING_SAMPLING_PROBABILITY=0.05`.
2. Mirror collector traffic and verify no rejected trace-context spike for 30 minutes.
3. Canary 5%, 25%, 50%, then 100% of production traffic while checking latency and error alerts.
4. Increase sampling to the target rate only after P99 request latency stays below 100 ms for critical routes.
5. Keep the previous green environment warm until canary analysis passes.
