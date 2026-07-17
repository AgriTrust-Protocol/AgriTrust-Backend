# Automated Performance Regression Detection

AgriTrust enforces performance gates in CI for critical HTTP paths before a change can merge.

## Architecture

1. GitHub Actions starts the API in CI mode.
2. `tests/load/load-test.js --ci` drives representative critical-path traffic and writes a JSON report.
3. `npm run performance:check -- <report>` evaluates every sample with the shared budget logic in `src/performance/regression.ts`.
4. Any P99 latency above 100ms, availability below 99.99%, error rate above 0.01%, or insufficient sample count fails the pipeline.

## Monitoring and alerting

The application already exposes unified Prometheus metrics at `/metrics`. Dashboards should graph `http_request_duration_seconds` P99 by route, request volume, and status-code error rate. Alerts should page when critical-path P99 remains above 100ms for five minutes or availability drops below 99.99%.

## Deployment strategy

Use blue-green deployment for backend releases. Send 5% canary traffic to the green stack, compare its P99 and availability against the blue baseline, and only promote when the CI budget and production canary analysis both pass.
