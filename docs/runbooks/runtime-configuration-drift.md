# Runtime Configuration Drift Runbook

## Symptoms

- `runtime_config_drift_total{severity="critical"}` increases.
- Canary analysis blocks promotion because the candidate environment differs from the approved baseline.
- A service health payload reports runtime configuration drift.

## Triage

1. Identify the service and key labels from `runtime_config_drift_total`.
2. Compare the deployed release version with the approved baseline artifact for that environment.
3. If a critical key changed unexpectedly, freeze promotion and keep traffic on the current blue environment.
4. Rotate credentials if the drift involves secret references or credential material.
5. Rebuild the baseline only after security review approves the runtime value.

## Recovery

- Roll back dynamic configuration to the approved value when possible.
- Otherwise, deploy a corrected green environment and restart canary analysis from 0% traffic.
- Close the incident after audits are clean for two audit intervals and dashboards show no new critical drift.
