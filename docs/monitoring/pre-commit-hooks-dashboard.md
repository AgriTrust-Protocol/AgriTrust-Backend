# Dashboard: Pre-Commit Hook Quality Gates

Track the following CI metrics for the `npm run precommit` job:

| Panel | Metric | Alert |
| --- | --- | --- |
| Job result | Pass/fail count by branch | Page after three consecutive failures on the protected branch |
| Duration | P50/P95/P99 job duration | Warn when P99 doubles week over week |
| Failure reason | Secret scan, build, or test failure category | Notify the owning team for repeated category failures |
| Adoption | PRs with successful pre-commit job | Block merges when the required check is absent |

The hook suite does not run in production and should not be included in service SLO burn-rate dashboards.
