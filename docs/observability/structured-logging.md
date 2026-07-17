# Structured Logging with OpenTelemetry Semantic Conventions

AgriTrust backend services emit newline-delimited JSON logs through `StructuredLogger`. Each log record mirrors the OpenTelemetry log data model so collectors can ingest stdout without parsing free-form text.

## Architecture

- Application code calls `logger.info`, `logger.warn`, `logger.error`, or `logger.fatal` from `src/logging/structured-logger.ts`.
- The logger enriches every record with OpenTelemetry-compatible fields: `timestamp`, `severity_text`, `severity_number`, `body`, trace correlation fields, `resource`, and `attributes`.
- The current active OpenTelemetry span context is copied into `trace_id`, `span_id`, and `trace_flags`, allowing dashboards to pivot directly from logs to traces.
- HTTP request completion logging is wired into the tracing middleware and uses stable semantic convention attribute names such as `http.request.method`, `http.response.status_code`, `url.path`, `client.address`, and `user_agent.original`.
- Sensitive fields whose names include credentials, tokens, cookies, secrets, or passwords are redacted before logs are emitted.

## Operational Notes

- Keep high-cardinality business identifiers under the `agritrust.*` namespace and use them only when needed for incident response.
- Log critical path completion once per request to preserve the sub-100ms P99 latency target.
- Configure collectors to parse stdout as JSON and preserve `trace_id`/`span_id` fields for log-to-trace correlation.
- Alerting should focus on error/fatal log rates and request duration metrics; dashboards should group by `service.name`, `deployment.environment.name`, route, and status code.

## Deployment Guidance

Roll out logger adoption behind the existing blue-green and canary process. During canary analysis, compare error log rates, request P99 latency, and collector ingestion errors between the baseline and canary pools before increasing traffic.
