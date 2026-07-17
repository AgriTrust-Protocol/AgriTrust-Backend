# Service Mesh Integration with Mutual TLS

## Architecture

AgriTrust runs behind the platform service mesh with sidecar-to-sidecar mutual TLS. The application keeps its existing device certificate validation for edge/device identity, while the mesh enforces workload identity and encrypted in-cluster service-to-service traffic.

The default policy is:

- Mesh provider: Istio.
- Namespace: `agritrust`.
- Workload service: `agritrust-backend` / `agritrust-backend.agritrust.svc.cluster.local`.
- mTLS mode: `STRICT` for all inbound workload traffic.
- Critical path latency objective: p99 <= 100 ms.
- Availability objective: 99.99%.
- Rollout strategy: blue-green with a 5% initial green canary.

## Runtime policy controls

The `src/service-mesh/mtls-policy.ts` module centralizes mesh guardrails and rejects unsafe settings such as permissive mTLS, p99 targets above 100 ms, or availability below 99.99%.

Supported environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SERVICE_MESH_ENABLED` | `true` | Enables service mesh readiness checks. |
| `SERVICE_MESH_PROVIDER` | `istio` | Mesh implementation: `istio`, `linkerd`, `consul`, or `none`. |
| `SERVICE_MESH_NAMESPACE` | `agritrust` | Kubernetes namespace for generated policy. |
| `SERVICE_MESH_SERVICE_NAME` | `agritrust-backend` | Logical service name. |
| `SERVICE_MESH_MTLS_MODE` | `STRICT` | Required mTLS posture when enabled. |
| `SERVICE_MESH_P99_TARGET_MS` | `100` | Maximum critical path p99 latency. |
| `SERVICE_MESH_AVAILABILITY_TARGET` | `99.99` | Minimum uptime objective. |
| `SERVICE_MESH_CANARY_INITIAL_WEIGHT` | `5` | Initial green deployment traffic percentage. |
| `SERVICE_MESH_CANARY_MAX_WEIGHT` | `50` | Maximum canary traffic before promotion. |
| `SERVICE_MESH_CANARY_ERROR_RATE_THRESHOLD` | `1` | Canary error-rate rollback threshold. |
| `SERVICE_MESH_CANARY_P99_THRESHOLD_MS` | `100` | Canary latency rollback threshold. |

## Kubernetes resources

`k8s/service-mesh/istio-mtls.yaml` provides the baseline Istio resources:

1. `PeerAuthentication` sets namespace/workload mTLS to `STRICT`.
2. `DestinationRule` uses `ISTIO_MUTUAL` for service calls.
3. `VirtualService` sends 95% of traffic to blue and 5% to green, with header-based full green routing for targeted canary checks.
4. Blue and green subsets are selected by the `version` label.

## Monitoring and alerting

Prometheus alert rules in `monitoring/alerts/service-mesh-mtls.yaml` cover missing mTLS telemetry, p99 latency above 100 ms, and 99.99% availability budget burn. The Grafana dashboard in `monitoring/dashboards/service-mesh-mtls.json` visualizes mTLS request volume, p99 latency, and 5xx error rate.

## Security review checklist

- Confirm all application pods have mesh sidecar injection enabled.
- Confirm plaintext service ports are not exposed outside the mesh boundary.
- Confirm `PeerAuthentication` is `STRICT` before shifting production traffic.
- Confirm edge/device mTLS remains enabled where device identity is required.
- Confirm service account identities are least-privilege and namespace-scoped.
