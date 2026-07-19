# Runtime Configuration Auditing and Drift Detection

Runtime configuration auditing protects AgriTrust services from undeclared environment, feature flag, secret reference, and runtime knob changes. Each service owns a small in-process auditor that snapshots its effective configuration, hashes each key/value pair, compares it to the approved deployment baseline, and emits Prometheus metrics plus structured audit events.

## Architecture

1. **Baseline generation** happens during release promotion after security review. The blue environment establishes a hash-only baseline from the same config artifact used by the canary.
2. **Runtime audit loop** runs in every service on startup, after dynamic config reloads, and on a fixed interval. The core compare path is O(number of config keys) and is designed to remain under the 100 ms P99 critical-path target for normal service snapshots.
3. **Drift classification** marks missing, added, or changed critical keys as `critical`; all other differences are `warning`.
4. **Observability** uses `runtime_config_audit_duration_ms`, `runtime_config_drift_total`, and `runtime_config_last_audit_timestamp_seconds` to drive dashboards and alerts.
5. **Deployment safety** gates blue-green promotion and canary expansion when critical drift appears in the candidate environment.

## Security model

Snapshots never export raw secret values. Keys matching secret-like names, or keys explicitly listed by a service, are redacted before hashing. Audit results contain only per-key hashes and aggregate snapshot hashes so operators can prove drift without leaking credentials.

## Availability and performance

Audits run locally and do not block request handling. Services should cache the last result for health endpoints and avoid network calls inside snapshot providers. Alerting is asynchronous, preserving the 99.99% availability target.
