# Secret Rotation Runbook

## Alerts

### SecretRotationFailures

1. Check `secret_rotation_attempts_total{result="failure"}` by target.
2. Inspect Vault availability and policy permissions for the failing path.
3. Verify canary checks can authenticate with the candidate database user or API key.
4. Keep traffic on the blue stack if failures occur during canary deployment.

### SecretRotationStale

1. Compare target staleness with its configured interval.
2. Restart the rotation worker only after confirming Vault is healthy.
3. If credentials might be exposed, revoke the affected Vault lease and force an immediate rotation.

## Manual Rotation

1. Trigger the service rotation endpoint or job runner for the target.
2. Confirm success in Prometheus: `secret_rotation_attempts_total{result="success"}` increases.
3. For database credentials, confirm pool health and absence of connection errors.
4. Shift canary traffic to 25%, 50%, then 100% after five clean minutes per step.
