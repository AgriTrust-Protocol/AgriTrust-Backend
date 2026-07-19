# Docker CI Layer Caching Runbook

## Normal operation

1. Open the Docker image workflow for the target branch or pull request.
2. Confirm the Buildx setup step completed successfully.
3. Inspect the build log for cache activity. Healthy builds should show cache hits for npm dependency layers when `package-lock.json` is unchanged.
4. Confirm Trivy scan results were uploaded to code scanning.
5. For main branch builds, deploy the immutable `sha-<git sha>` tag using the blue-green release process.

## Alerts

### DockerCICacheMissRateHigh

Impact: CI builds may become slower, increasing lead time for changes.

Triage:

1. Check whether `package-lock.json`, `Dockerfile`, or the Buildx cache scope changed.
2. Confirm the workflow can read the GitHub Actions cache and pull `:buildcache` from GHCR.
3. Verify `.dockerignore` is excluding files that should not affect build cache keys.
4. Re-run the workflow after a successful main build warms the registry cache.

### DockerCIBuildDurationHigh

Impact: Docker image builds are exceeding expected duration and may delay deployments.

Triage:

1. Compare dependency installation time with source build time in the BuildKit log.
2. Check runner availability and network latency to npm and GHCR.
3. Review recent dependency changes for native modules or large transitive dependency additions.
4. If duration remains elevated, temporarily increase rollout lead time and investigate cache export failures.

## Rollback

1. Do not promote the candidate image if build, scan, or canary checks fail.
2. Keep production traffic on the blue environment.
3. Redeploy the last known-good immutable SHA tag if green already received traffic.
4. Open an incident follow-up with the failing workflow run, image digest, and Trivy SARIF artifact attached.
