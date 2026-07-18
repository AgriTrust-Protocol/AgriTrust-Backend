# Performance Regression Runbook

## Trigger

CI fails the `performance` job or production alerts report critical-path P99 latency above 100ms.

## Triage

1. Download the `performance-report` artifact from GitHub Actions.
2. Identify the violating route and compare it with `/metrics` histograms.
3. Check recent application, database, and Soroban RPC changes.
4. Roll back the green/canary deployment if production availability is below 99.99%.

## Resolution

- Optimize or revert the slow path.
- Re-run `npm test` and `npm run performance:check -- <report>` with a fresh report.
- Resume canary analysis and promote only after the P99 and availability gates pass.
