# Docker CI Layer Caching Architecture

## Goals

AgriTrust backend CI builds use Docker BuildKit layer caching to reduce image build time while preserving deterministic production images, security scanning, and rollback-friendly publishing.

Targets:

- Reuse dependency and TypeScript build layers across pull requests and main branch builds.
- Keep critical runtime paths under the existing 100 ms P99 service target by ensuring the runtime image contains only production dependencies and compiled assets.
- Maintain 99.99% availability by publishing immutable SHA tags and retaining a mutable build cache separately from deployable tags.
- Preserve security review gates by producing SBOM/provenance attestations and failing CI on high or critical Trivy findings.

## Layering strategy

The `Dockerfile` is split into four stages:

1. `deps` installs all npm dependencies from `package-lock.json` with a BuildKit npm cache mount.
2. `build` copies source files after dependency installation so source-only changes do not invalidate the npm install layer.
3. `production-deps` installs only production dependencies for the runtime image.
4. `runtime` runs as the non-root `node` user and copies only production dependencies, package manifests, compiled output, and the entrypoint.

The `.dockerignore` file excludes local dependencies, documentation, CI metadata, temporary files, and secrets so cache keys are driven by deployable inputs rather than workstation artifacts.

## CI cache topology

The GitHub Actions workflow uses Docker Buildx with two cache backends:

- `type=gha` provides fast pull-request cache restores scoped to the backend runtime image.
- `type=registry` publishes `ghcr.io/<owner>/<repo>:buildcache` on non-PR builds to share warm cache layers across runners and branches.

The workflow pushes deployable images only for non-PR events. Pull requests build and load the image locally for scanning without publishing deployable tags.

## Security and supply chain controls

- BuildKit provenance and SBOM generation are enabled for published images.
- Trivy scans OS and library packages and fails on `HIGH` or `CRITICAL` vulnerabilities.
- The runtime stage runs as `node`, not root.
- The CI token is scoped to repository contents, packages, and SARIF upload.

## Deployment guidance

Use the immutable `sha-<git sha>` image tag produced by the workflow for blue-green deployments. Promote the new green environment only after canary analysis confirms:

- HTTP P99 latency remains below 100 ms for critical routes.
- Error rate does not regress from the previous image.
- Container startup and readiness timings remain within the service SLO budget.
- No high or critical vulnerability scan failures occurred for the candidate image.

If any canary check fails, keep the blue environment serving traffic and roll the green deployment back to the previous SHA tag.
