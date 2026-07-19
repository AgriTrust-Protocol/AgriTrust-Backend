# Pre-Commit Hook Suite

## Architecture

AgriTrust uses a repository-local Git hook suite to stop low-quality or unsafe changes before they leave a developer workstation. `npm run prepare` configures `core.hooksPath` to `.githooks`, and `.githooks/pre-commit` delegates to `npm run precommit` so every check is versioned with the repository.

The suite currently enforces three gates:

1. **Secret scanning** over staged text files for private keys, AWS access keys, and high-entropy token assignments.
2. **Automated tests** with `npm test`.
3. **Optional TypeScript build validation** with `AGRITRUST_PRECOMMIT_FULL=1 npm run precommit` or `npm run precommit -- --full` for CI and release branches.

The secret scanner only reads staged files and only scans known text extensions, keeping the fast path small while preventing binary-file overhead. The test gate exercises the repository Vitest suite on every commit. CI and release branches should enable the optional build gate to exercise all services affected by the repository-wide TypeScript configuration once the existing compile backlog is cleared.

## Operations and Monitoring

Pre-commit hooks run locally, so they do not emit production telemetry or affect the API critical path. CI should continue to run `npm run precommit` and can enable `npm run precommit -- --full` for release validation and publish job duration, failure counts, and failure reasons as pipeline metrics. Alert on repeated main-branch CI failures or P99 pre-commit job duration regressions above the team threshold.

## Deployment Strategy

The hook suite is deployed by merging the versioned `.githooks` directory and package scripts. Developers receive the hook after running `npm install` or `npm run prepare`. CI canary validation should run `npm run precommit` on the pull request branch before enabling the same command as a required merge check on protected branches. After the compile backlog is fixed, canary `npm run precommit -- --full` before making the full gate required.

## Security Review

Secret findings fail closed and print the matched finding class without revealing secret values. If a rule produces a false positive, rewrite the fixture to avoid secret-like literals instead of bypassing the hook. Use `git commit --no-verify` only for emergency break-glass changes that have an explicit security-review follow-up.
