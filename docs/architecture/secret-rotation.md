# Secret Rotation Service Architecture

AgriTrust rotates database credentials and API keys through Vault-backed, application-local rotation workers. The design keeps critical request paths under the 100 ms P99 target by performing Vault reads, canary validation, pool swaps, and environment updates out of band from request handling.

## Flow

1. `SecretRotationService` loads rotation targets from configured Vault mappings or explicit service bootstrap code.
2. Each target reads the candidate secret from Vault and runs an optional canary before activation.
3. Database targets atomically create a new `MonitoredPool` through `RotatingPgPoolFactory`; the previous pool drains for 30 seconds to support blue-green cutover.
4. API-key targets update only the mapped process environment variable and never emit the secret value in metrics.
5. Dynamic Vault leases are handed to `LeaseManager` so credentials renew at half TTL and are visible through the admin status endpoint.

## Security Controls

- Secret values are not used as metric labels, logged, or returned in status payloads.
- Failed canaries prevent activation of candidate credentials.
- Vault lease IDs and TTL metadata are tracked separately from secret material.
- Last-known-good fallback remains limited to boot-time injection and should trigger manual rotation after recovery.

## Operations

- Roll out with blue-green deployments: enable the rotation worker on the green stack, validate canary and metrics, then shift traffic.
- Canary analysis should watch `secret_rotation_attempts_total`, `secret_rotation_duration_seconds`, and database pool health before increasing traffic.
- Alert when any target has no successful rotation for more than its expected rotation interval.
