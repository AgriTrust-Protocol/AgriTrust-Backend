# Runbook: Pre-Commit Hook Failures

## Symptoms

A commit fails before the editor opens or CI reports a failed `npm run precommit` job.

## Triage

1. Run `npm run precommit` locally from the repository root.
2. If secret scanning fails, remove the secret-like value from the staged file and rotate any real credential that was exposed.
3. If tests fail, run `npm test` and inspect the failing Vitest suite.
4. If full validation fails, run `npm run build` and fix the first compiler error.

## Rollback

The hook has no production runtime footprint. To roll back a faulty rule, revert the hook commit or temporarily remove the affected rule from `scripts/precommit-checks.js` in a hotfix PR. Do not disable `core.hooksPath` as a team-wide workaround.

## Escalation

Escalate suspected leaked credentials to the security owner immediately. Escalate repeated CI-only failures to the platform owner with the failing command output and the commit SHA.
