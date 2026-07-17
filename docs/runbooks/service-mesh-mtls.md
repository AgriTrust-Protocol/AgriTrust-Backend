# Runbook: Service Mesh mTLS Rollout and Recovery

## Pre-deployment

1. Build and test the application.
2. Apply the mesh manifests to a staging namespace.
3. Verify the mesh reports `connection_security_policy="mutual_tls"` for AgriTrust traffic.
4. Confirm p99 latency remains below 100 ms during load testing.
5. Obtain security review approval for the strict mTLS policy and service account permissions.

## Blue-green and canary rollout

1. Deploy the green version with `version=green` labels while blue remains active.
2. Route synthetic checks with `x-canary: true` and validate health, metrics, and logs.
3. Shift 5% of normal traffic to green.
4. Continue canary only while p99 latency is <= 100 ms and 5xx error rate is below 1%.
5. Increase traffic gradually to 25%, 50%, and 100% after each analysis window passes.
6. Promote green to blue after a stable post-promotion observation window.

## Rollback triggers

Rollback immediately if any of the following occur:

- `ServiceMeshMutualTlsPolicyMissing` fires for production traffic.
- p99 latency exceeds 100 ms for 10 minutes.
- 5xx error rate exceeds the configured error budget burn threshold.
- Sidecar injection fails for any production pod.
- Security review identifies an unsafe mesh identity or plaintext path.

## Recovery

1. Set green weight to 0 in the `VirtualService`.
2. Confirm all production traffic is routed to blue.
3. Inspect sidecar, application, and control-plane logs.
4. Validate certificates, trust bundle distribution, and service account identity.
5. Re-run canary analysis from 5% only after the root cause is fixed.
