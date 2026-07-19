# Runbook: Database Migrations and Rollbacks

## Apply migrations

```bash
npm run migrate -- up
```

## Roll back to a known good version

```bash
npm run migrate -- down 20260718000001
```

## Check status and planning

```bash
npm run migrate -- status
npm run migrate -- plan
```

## Alerts

Investigate immediately when `DatabaseMigrationFailure` fires. Confirm the failing version, inspect database locks, and do not advance canary traffic until the migration is either fixed or rolled back.
