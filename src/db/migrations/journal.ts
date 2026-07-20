import { PoolClient } from 'pg';

/**
 * AgriTrust Protocol – Migration Rollback Journal
 *
 * Persists undo metadata for every migration applied by the MigrationRunner.
 * The journal table (`_migration_journal`) is a first-class audit trail that
 * enables the runner to roll back to any previously applied migration snapshot
 * without relying on the original migration files being present.
 *
 * Schema invariants
 * ─────────────────
 * • Up to MAX_UNDO_BLOCKS (256) undo blocks are stored per run.
 * • Each undo block (undo_sql column) must be < MAX_UNDO_BLOCK_BYTES (1 MB).
 * • `affected_tables` is a TEXT[] column used to rebuild the lock-key on rollback.
 * • Entries are soft-deleted by setting `rolled_back_at`; physical rows are
 *   retained for audit purposes.
 */

export const MAX_UNDO_BLOCKS = 256;
export const MAX_UNDO_BLOCK_BYTES = 1_048_576; // 1 MB

export interface JournalEntry {
  id: number;
  checksum: string;
  version: string;
  name: string;
  appliedAt: Date;
  undoSql: string;
  affectedTables: string[];
  rolledBackAt: Date | null;
}

export class MigrationJournal {
  /**
   * Creates the `_migration_journal` table if it does not already exist.
   * Idempotent — safe to call on every runner boot.
   */
  async ensureSchema(client: Pick<PoolClient, 'query'>): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migration_journal (
        id               BIGSERIAL PRIMARY KEY,
        checksum         TEXT        NOT NULL,
        version          TEXT        NOT NULL,
        name             TEXT        NOT NULL,
        applied_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        undo_sql         TEXT        NOT NULL,
        affected_tables  TEXT[]      NOT NULL DEFAULT '{}',
        rolled_back_at   TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_migration_journal_version
        ON _migration_journal (version)
        WHERE rolled_back_at IS NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_migration_journal_applied_at
        ON _migration_journal (applied_at DESC)
        WHERE rolled_back_at IS NULL
    `);
  }

  /**
   * Appends a journal entry for a successfully applied migration.
   *
   * @throws Error if the undo_sql exceeds MAX_UNDO_BLOCK_BYTES.
   * @throws Error if there are already MAX_UNDO_BLOCKS active (non-rolled-back) entries.
   */
  async append(
    client: Pick<PoolClient, 'query'>,
    entry: {
      checksum: string;
      version: string;
      name: string;
      undoSql: string;
      affectedTables: string[];
      appliedAt: Date;
    },
  ): Promise<void> {
    const undoBytes = Buffer.byteLength(entry.undoSql, 'utf8');
    if (undoBytes > MAX_UNDO_BLOCK_BYTES) {
      throw new Error(
        `MigrationJournal: undo_sql for migration ${entry.version} exceeds the ` +
          `${MAX_UNDO_BLOCK_BYTES}-byte limit (got ${undoBytes} bytes).`,
      );
    }

    // Count active undo blocks (not yet rolled back).
    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM _migration_journal WHERE rolled_back_at IS NULL`,
    );
    const activeCount = Number(countRes.rows[0]?.count ?? 0);
    if (activeCount >= MAX_UNDO_BLOCKS) {
      throw new Error(
        `MigrationJournal: per-run undo block limit (${MAX_UNDO_BLOCKS}) reached. ` +
          'Purge old journal entries before applying more migrations.',
      );
    }

    await client.query(
      `INSERT INTO _migration_journal
         (checksum, version, name, applied_at, undo_sql, affected_tables)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [
        entry.checksum,
        entry.version,
        entry.name,
        entry.appliedAt,
        entry.undoSql,
        entry.affectedTables,
      ],
    );
  }

  /**
   * Marks a journal entry as rolled back (soft-delete).
   */
  async markRolledBack(
    client: Pick<PoolClient, 'query'>,
    version: string,
    rolledBackAt: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE _migration_journal
          SET rolled_back_at = $2
        WHERE version = $1
          AND rolled_back_at IS NULL`,
      [version, rolledBackAt],
    );
  }

  /**
   * Returns all active (not yet rolled back) journal entries in descending
   * applied_at order (most recent first) — ready for use by rollbackTo().
   */
  async listActive(client: Pick<PoolClient, 'query'>): Promise<JournalEntry[]> {
    const res = await client.query<{
      id: string;
      checksum: string;
      version: string;
      name: string;
      applied_at: Date;
      undo_sql: string;
      affected_tables: string[];
      rolled_back_at: Date | null;
    }>(
      `SELECT id, checksum, version, name, applied_at, undo_sql, affected_tables, rolled_back_at
         FROM _migration_journal
        WHERE rolled_back_at IS NULL
        ORDER BY applied_at DESC, id DESC`,
    );

    return res.rows.map((row) => ({
      id: Number(row.id),
      checksum: row.checksum,
      version: row.version,
      name: row.name,
      appliedAt: row.applied_at,
      undoSql: row.undo_sql,
      affectedTables: row.affected_tables,
      rolledBackAt: row.rolled_back_at,
    }));
  }

  /**
   * Returns a single journal entry by migration version, or null if not found.
   */
  async findByVersion(
    client: Pick<PoolClient, 'query'>,
    version: string,
  ): Promise<JournalEntry | null> {
    const res = await client.query<{
      id: string;
      checksum: string;
      version: string;
      name: string;
      applied_at: Date;
      undo_sql: string;
      affected_tables: string[];
      rolled_back_at: Date | null;
    }>(
      `SELECT id, checksum, version, name, applied_at, undo_sql, affected_tables, rolled_back_at
         FROM _migration_journal
        WHERE version = $1
        ORDER BY id DESC
        LIMIT 1`,
      [version],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: Number(row.id),
      checksum: row.checksum,
      version: row.version,
      name: row.name,
      appliedAt: row.applied_at,
      undoSql: row.undo_sql,
      affectedTables: row.affected_tables,
      rolledBackAt: row.rolled_back_at,
    };
  }
}
