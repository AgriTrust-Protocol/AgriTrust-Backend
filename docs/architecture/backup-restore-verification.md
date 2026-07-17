# Scheduled Database Backup Verification Architecture

AgriTrust verifies database backups by restoring the latest backup into an isolated disposable database and running smoke queries before the backup is considered usable for recovery.

## Flow

1. A scheduled job selects the latest backup from the backup catalog.
2. `BackupRestoreVerifier` creates a unique sandbox database name and asks the restore adapter to restore the backup into that sandbox.
3. Read-only verification checks validate schema migrations and critical tables.
4. Prometheus metrics record run duration, pass/fail counts, backup age, and the timestamp of the last successful restore test.
5. The sandbox is destroyed in a `finally` block regardless of success or failure.

## Operational bounds

- The verification path is asynchronous and must not be called from request-critical paths, preserving the <100 ms P99 target for production APIs.
- Restore credentials must be scoped to disposable verification databases and must not have write access to production databases.
- Run the job in the green environment during blue-green deployments before shifting traffic, then keep canary analysis watching failure counts and latest successful verification age.
