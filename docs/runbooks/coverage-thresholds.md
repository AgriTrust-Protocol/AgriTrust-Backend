# Code Coverage Threshold Enforcement

## Architecture

The CI pipeline enforces system-wide test coverage through Vitest's V8 coverage provider. Pull requests and pushes to long-lived branches run the same workflow:

1. Install dependencies.
2. Compile TypeScript.
3. Run the test suite with coverage enabled.
4. Fail the job when global line, function, branch, or statement coverage is below the configured threshold.
5. Upload the generated coverage report as a CI artifact for review.

Coverage enforcement is intentionally centralized in `vitest.config.ts` so every service and module included under `src/` is evaluated consistently.

## Threshold policy

The current global threshold is 80% for each coverage dimension:

- Lines
- Functions
- Branches
- Statements

The threshold applies across the whole backend codebase. Generated or non-runtime files such as TypeScript declaration files, SQL migrations, and SQL query files are excluded from coverage calculations.

## Local validation

Run the same check locally before opening a pull request:

```bash
npm run test:coverage
```

If the command fails, open `coverage/index.html` or inspect the terminal summary to identify files with missing coverage.

## Monitoring and alerting

GitHub Actions is the source of truth for coverage enforcement. A failed `Test and enforce coverage` job blocks merging and acts as the alert for coverage regressions. The workflow uploads the `coverage/` directory on every run so reviewers can inspect the LCOV and JSON summary artifacts.

## Deployment strategy

This change affects CI only and has no runtime deployment footprint. Normal application releases can continue to use the existing deployment process; no blue-green or canary traffic shift is required for coverage enforcement itself.

## Operational response

When coverage enforcement fails:

1. Review the CI coverage summary and downloaded artifact.
2. Add or adjust tests for the uncovered production code.
3. Re-run `npm run test:coverage` locally.
4. Push the fix and verify that GitHub Actions passes.

Do not lower thresholds to bypass a regression unless the team explicitly approves a temporary exception with a follow-up issue.
