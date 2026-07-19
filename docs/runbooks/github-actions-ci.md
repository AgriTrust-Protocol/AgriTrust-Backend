# GitHub Actions CI runbook

## When the workflow is slow

1. Confirm that old runs for the same branch were cancelled by the workflow concurrency group.
2. Compare the duration of each matrix job to determine whether build, tests, contracts, or performance gates are the bottleneck.
3. Check whether dependency restore missed the npm cache by reviewing the `Setup Node.js` step.
4. If all matrix jobs are healthy but total duration is high, split the slowest test suite further instead of serializing jobs.

## When a quality gate fails

1. Open the failing matrix job and copy the exact command from the `Run` step.
2. Reproduce locally with the same npm script.
3. Fix the failing suite and rerun the workflow. Other matrix failures from the same run should be reviewed before pushing again.

## When a security gate fails

1. For `npm audit` failures, upgrade or replace the vulnerable production dependency before release.
2. For CodeQL alerts, review the uploaded security event and request security-owner approval after remediation.
3. Do not proceed to release-readiness until the security job is green.

## Blue-green and canary promotion checklist

1. Confirm release-readiness completed after quality and security jobs passed.
2. Deploy to the inactive color and validate health checks.
3. Shift traffic through 5%, 25%, 50%, and 100% stages.
4. Stop or roll back if P99 latency is at least 100ms, error rate increases, or uptime SLO burn threatens 99.99% availability.
