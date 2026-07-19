# Database Migration Versioning with Rollback Support

AgriTrust migrations are ordered SQL files in `src/database/migrations` using `<version>_<name>.sql`. The `MigrationManager` records every applied version in `schema_migrations`, stores a SHA-256 checksum, and uses a PostgreSQL advisory lock so only one deploy job mutates the schema at a time.

## File format

```sql
-- migrate:up
CREATE TABLE example (...);

-- migrate:down
DROP TABLE example;
```

The rollback section is mandatory for migrations that may be reversed. Rollbacks fail closed if the file is missing, the checksum has changed, or the down section is absent.

## Deployment flow

1. Run `npm run migrate -- up` in the green environment before shifting traffic.
2. Verify `/metrics` exposes `database_migration_current_version` and successful execution counters.
3. Start canary traffic against green and compare database error rate, latency, and migration metrics.
4. Complete blue-green cutover only after canary analysis passes.
5. If canary fails because of a schema change, run `npm run migrate -- down <last_good_version>` before routing traffic back.

## Performance and availability

Migrations run inside transactions with local lock and statement timeouts to prevent long blocking operations. Application critical paths read only the resulting schema; migration status checks use indexed lookups on `schema_migrations` and are designed to stay below the 100 ms P99 target.
