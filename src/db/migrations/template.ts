import { PoolClient } from 'pg';

/**
 * AgriTrust Protocol – Migration File Template
 *
 * Every migration file must export:
 *  - `up`            : forward schema change
 *  - `down`          : compensating rollback
 *  - `transactional` : whether the migration runs inside a SERIALIZABLE transaction.
 *                      Set to false only for DDL that cannot run inside a transaction
 *                      (e.g. CREATE INDEX CONCURRENTLY).
 *  - `allowDdl`      : required when transactional is false; acts as an explicit
 *                      opt-in guard to prevent accidental non-transactional DDL.
 *  - `affectedTables`: list of table names whose schema is mutated.  Used by the
 *                      LockManager to acquire advisory locks and by the phantom-read
 *                      guard to assert no concurrent queries before applying.
 *
 * Naming convention for migration files:
 *   YYYYMMDD_HHMMSS_description.ts
 *
 * Example filename: 20260720_143000_create_widgets_table.ts
 */

export interface Migration {
  /**
   * Apply the schema change.
   * Receives a live PoolClient; do NOT call BEGIN/COMMIT — the runner manages
   * the transaction boundary (or asserts no active queries for DDL-only migrations).
   */
  up(client: PoolClient): Promise<void>;

  /**
   * Revert the schema change.
   * Called by the rollback orchestrator when rolling back to a prior snapshot.
   */
  down(client: PoolClient): Promise<void>;

  /**
   * When true (default), the runner wraps up()/down() in a SERIALIZABLE
   * transaction.  Phantom-read safety is enforced at the isolation level.
   *
   * When false, the migration runs outside a transaction.  The runner will
   * assert that no active queries are touching `affectedTables` before
   * proceeding (via pg_stat_activity) and requires allowDdl: true.
   */
  transactional: boolean;

  /**
   * Must be true when transactional is false.  Serves as an explicit
   * acknowledgement that the caller understands non-transactional DDL risks
   * (e.g. CREATE INDEX CONCURRENTLY cannot run inside a transaction).
   */
  allowDdl?: boolean;

  /**
   * Tables whose schema is mutated by this migration.
   * Used by LockManager to hash advisory lock keys and by the phantom-read
   * guard to check pg_stat_activity before applying.
   */
  affectedTables: string[];
}

/**
 * Example skeleton — copy this into a new file and fill in the details.
 *
 * File name: 20260720_143000_create_example_table.ts
 */
export const exampleMigration: Migration = {
  transactional: true,
  affectedTables: ['example_table'],

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS example_table (
        id   BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS example_table');
  },
};
