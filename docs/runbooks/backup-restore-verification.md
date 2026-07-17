# Runbook: Backup Restore Verification

## Alerts

- `DatabaseBackupVerificationFailed`: page when `increase(database_backup_verification_total{status="failed"}[15m]) > 0`.
- `DatabaseBackupVerificationStale`: page when `time() - database_backup_last_success_timestamp_seconds > 86400`.
- `DatabaseBackupTooOld`: warn when `database_backup_latest_age_seconds > 21600`.

## Triage

1. Check the most recent job logs for the failing check name and sandbox database name.
2. Confirm the backup catalog contains a recent backup and that object storage credentials are valid.
3. Verify the disposable restore role can create, query, and drop sandbox databases.
4. If the latest backup is corrupt, promote the newest passing backup and open an incident for backup pipeline repair.

## Deployment

Use blue-green deployment. Run one verification in green before cutover and require zero failed restore checks during canary analysis.
