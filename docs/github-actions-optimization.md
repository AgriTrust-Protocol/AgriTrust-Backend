# GitHub Actions optimization architecture

## Goals

The CI workflow is designed to shorten feedback loops while preserving the service targets used by AgriTrust critical paths: P99 latency below 100ms, 99.99% availability, and mandatory security review before release eligibility.

## Parallel execution model

The workflow uses a small dependency-install warm-up job followed by independent quality gates that run in parallel through a matrix:

- TypeScript compilation validates build correctness.
- Unit and integration tests validate core service behavior.
- OpenAPI contract tests protect API compatibility.
- Performance regression checks guard the latency budget.
- Security gates run independently with production dependency audit and CodeQL analysis.

`fail-fast: false` is intentionally enabled so that contributors receive the full set of failures from one run instead of repeatedly fixing one serialized failure at a time.

## Caching and cancellation

`actions/setup-node` restores the npm cache from `package-lock.json`, and each job uses `npm ci --prefer-offline` for deterministic installs. Workflow concurrency cancels obsolete runs on the same branch or pull request, which reduces queue pressure and avoids wasting hosted runner minutes.

## Security review

The security job is a required release dependency and checks production dependencies with a high-severity audit threshold before running CodeQL for JavaScript and TypeScript sources. The workflow grants read-only repository permissions by default and limits `security-events: write` to jobs that upload security results.

## Release readiness, blue-green, and canary analysis

Pushes to protected integration branches produce a release-readiness summary only after all parallel quality and security gates pass. The documented deployment handoff is blue-green: deploy to the inactive color, validate health, then shift traffic through 5%, 25%, 50%, and 100% canary stages. Promotion must stop if P99 latency reaches or exceeds 100ms, error rate increases above baseline, or the 99.99% uptime burn-rate policy is violated.

## Monitoring and alerting hooks

The performance gate is the CI signal for latency regression and evaluates `config/performance-ci-baseline.json` as the checked-in critical-path budget until an external load-test artifact is supplied. Runtime monitoring remains owned by the existing Prometheus alert bundles and service dashboards; CI release-readiness summaries link the quality signal to the operational canary decision so responders have a consistent promotion checklist.
