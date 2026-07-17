# Runbook: distributed tracing

## Dashboards

Use the `AgriTrust Distributed Tracing` dashboard to inspect trace-context propagation, span duration P99, and invalid inbound context counts.

## Alerts

- `TraceContextRejectedSpike`: investigate clients or gateways sending malformed `traceparent` headers.
- `TraceSpanP99Above100ms`: inspect exemplars on `trace_span_duration_seconds` and compare with HTTP request latency.
- `TraceExporterBacklog`: check the OTLP collector endpoint and network policy.

## Triage steps

1. Confirm `/metrics` exposes `trace_context_propagation_total` and `trace_span_duration_seconds`.
2. Query recent traces by `trace_id` from the exemplar link on the HTTP or tracing histogram.
3. If collector export fails, reduce `TRACING_SAMPLING_PROBABILITY` and restart the canary deployment.
4. If baggage size causes header rejection, remove non-critical keys and keep only `agritrust.tenant-id` and `agritrust.batch-id`.
5. Roll back to the previous blue/green slot if P99 stays above 100 ms for 15 minutes.
