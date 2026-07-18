# Backup Restore Verification Dashboard

Recommended panels:

- Pass/fail runs: `sum by (status) (increase(database_backup_verification_total[24h]))`
- Restore verification duration P99: `histogram_quantile(0.99, sum by (le) (rate(database_backup_verification_duration_ms_bucket[15m])))`
- Latest backup age: `database_backup_latest_age_seconds`
- Last successful restore age: `time() - database_backup_last_success_timestamp_seconds`
