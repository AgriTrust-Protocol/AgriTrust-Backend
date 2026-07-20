import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../../api/metrics/registry';
import { MigrationJournal } from './journal';
import { LockManager } from './lock-manager';
import { Migration } from './template';

/**
 * AgriTrust Protocol – Migration Runner with Phantom-Read Safe Rollback Journaling
 *
 * Implements the transactional migration executor described in issue #40.
 *
 * Key invariants
 * ──────────────
 * 1. Every migration file is identified by a YYYYMMDD_HHMMSS_description.ts
 *    naming convention; an MD5 checksum of the compiled file path is stored
 *    in `_migration_journal` for idempotency.
 * 2. Transactional migrations run inside a SERIALIZABLE transaction; the
 *    LockManager acquires pg_advisory_xact_lock before applying.
 * 3. Non-transactional migrations (allowDdl: true, transactional: false) assert
 *    no active queries on affected tables before proceeding.
 * 4. On failure, down() is called and the failure is logged to the journal.
 * 5. Maximum migration duration is MAX_MIGRATION_DURATION_MS (300 s) — a
 *    statement_timeout is applied and a forced rollback is triggered on breach.
 * 6. rollbackTo(timestamp) applies undo blocks from the journal in reverse order.
 * 7. dryRun() (db:migrate:check) reports pending migrations without applying them.
 */

/** Maximum time a single migration may run before a forced rollback is triggered. */
export const MAX_MIGRATION_DURATION_MS = 300_000; // 300 s

/** Regex that validates migration filenames: YYYYMMDD_HHMMSS_description.ts */
export const MIGRATION_FILENAME_REGEX = /^(\d{8}_\d{6})_([a-z0-9_]+)\.ts$/;

// ─── Prometheus metrics ───────────────────────────────────────────────────────

export const runnerMigrationDurationMs = new Histogram({
  name: 'migration_runner_duration_ms',
  help: 'Duration of each migration execution in milliseconds',
  labelNames: ['version', 'direction', 'status'] as const,
  buckets: [10, 50, 100, 500, 1000, 5000, 15000, 60000, 300000],
  registers: [metricsRegistry],
});

export const runnerMigrationTotal = new Counter({
  name: 'migration_runner_executions_total',
  help: 'Total number of migration runner executions by direction and status',
  labelNames: ['direction', 'status'] as const,
  registers: [metricsRegistry],
});

export const runnerAppliedVersion = new Gauge({
  name: 'migration_runner_applied_version_timestamp',
  help: 'Unix timestamp of the most recently applied migration version',
  registers: [metricsRegistry],
});

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MigrationFileRecord {
  version: string;
  name: string;
  filePath: string;
  checksum: string;
}

export interface MigrationRunStep {
  version: string;
  name: string;
  direction: 'up' | 'down';
  durationMs: number;
}

export interface MigrationRunResult {
  applied: MigrationRunStep[];
  skipped: string[];
  dryRun: boolean;
}

export interface MigrationRunnerOptions {
  /** Directory containing .ts migration files. Defaults to src/db/migrations. */
  migrationsDir?: string;
  /** Milliseconds before a migration is forcibly rolled back. Default: 300 000. */
  maxDurationMs?: number;
  /** Injectable clock — used in tests to control timestamps. */
  now?: () => Date;
}

// ─── MigrationRunner ─────────────────────────────────────────────────────────

export class MigrationRunner {
  private readonly pool: Pool;
  private readonly journal: MigrationJournal;
  private readonly lockManager: LockManager;
  private readonly migrationsDir: string;
  private readonly maxDurationMs: number;
  private readonly now: () => Date;

  constructor(pool: Pool, options: MigrationRunnerOptions = {}) {
    this.pool = pool;
    this.journal = new MigrationJournal();
    this.lockManager = new LockManager({ acquireTimeoutMs: 10_000 });
    this.migrationsDir =
      options.migrationsDir ?? path.join(__dirname);
    this.maxDurationMs = options.maxDurationMs ?? MAX_MIGRATION_DURATION_MS;
    this.now = options.now ?? (() => new Date());
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Applies all pending migrations in ascending version order.
   *
   * @param targetVersion - Optional ceiling version (inclusive).  Only
   *   migrations whose version is ≤ targetVersion are applied.
   */
  async migrate(targetVersion?: string): Promise<MigrationRunResult> {
    const client = await this.pool.connect();
    try {
      await this.journal.ensureSchema(client);
      const files = await this.loadMigrationFiles();
      const appliedChecksums = await this.loadAppliedChecksums(client);

      const pending = files.filter(
        (f) =>
          !appliedChecksums.has(f.checksum) &&
          (!targetVersion || f.version <= targetVersion),
      );

      const applied: MigrationRunStep[] = [];
      const skipped: string[] = [];

      for (const file of pending) {
        const step = await this.applyOne(client, file);
        if (step) {
          applied.push(step);
        } else {
          skipped.push(file.version);
        }
      }

      if (applied.length > 0) {
        const lastVersion = applied[applied.length - 1].version;
        // Version string is YYYYMMDD_HHMMSS — parse as a unix-style number.
        const numeric = Number(lastVersion.replace('_', ''));
        if (!isNaN(numeric)) runnerAppliedVersion.set(numeric);
      }

      return { applied, skipped, dryRun: false };
    } finally {
      client.release();
    }
  }

  /**
   * Rolls back all migrations applied after (but not including) `targetVersion`
   * by executing undo blocks from the journal in reverse chronological order.
   *
   * @param targetVersion - Roll back all migrations with version > targetVersion.
   *   Omit to roll back everything.
   */
  async rollbackTo(targetVersion?: string): Promise<MigrationRunResult> {
    const client = await this.pool.connect();
    try {
      await this.journal.ensureSchema(client);
      const entries = await this.journal.listActive(client);

      // Entries are already in descending order (most recent first).
      const toRollback = entries.filter(
        (e) => !targetVersion || e.version > targetVersion,
      );

      const applied: MigrationRunStep[] = [];

      for (const entry of toRollback) {
        const startedAt = Date.now();
        try {
          await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          await this.lockManager.acquire(client, entry.affectedTables);
          await client.query(
            `SET LOCAL statement_timeout = ${this.maxDurationMs}`,
          );
          // Execute the undo block — either a sentinel (TypeScript migration)
          // or raw SQL (SQL-based migrations).
          await executeUndoFromSentinel(client, entry.undoSql);
          await this.journal.markRolledBack(client, entry.version, this.now());
          await client.query('COMMIT');

          const durationMs = Date.now() - startedAt;
          runnerMigrationDurationMs.observe(
            { version: entry.version, direction: 'down', status: 'success' },
            durationMs,
          );
          runnerMigrationTotal.inc({ direction: 'down', status: 'success' });
          applied.push({ version: entry.version, name: entry.name, direction: 'down', durationMs });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          runnerMigrationTotal.inc({ direction: 'down', status: 'failure' });
          runnerMigrationDurationMs.observe(
            { version: entry.version, direction: 'down', status: 'failure' },
            Date.now() - startedAt,
          );
          throw new Error(
            `MigrationRunner: rollback failed for version ${entry.version}: ${(err as Error).message}`,
          );
        }
      }

      return { applied, skipped: [], dryRun: false };
    } finally {
      client.release();
    }
  }

  /**
   * Dry-runs pending migrations — reports what would be applied without
   * executing up() or modifying the database.
   *
   * Implements the `db:migrate:check` CLI command.
   */
  async dryRun(targetVersion?: string): Promise<MigrationRunResult> {
    const client = await this.pool.connect();
    try {
      await this.journal.ensureSchema(client);
      const files = await this.loadMigrationFiles();
      const appliedChecksums = await this.loadAppliedChecksums(client);

      const pending = files.filter(
        (f) =>
          !appliedChecksums.has(f.checksum) &&
          (!targetVersion || f.version <= targetVersion),
      );

      const applied: MigrationRunStep[] = pending.map((f) => ({
        version: f.version,
        name: f.name,
        direction: 'up' as const,
        durationMs: 0,
      }));

      return { applied, skipped: [], dryRun: true };
    } finally {
      client.release();
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Applies a single migration file.  Returns a MigrationRunStep on success,
   * or null if the migration was already applied (checksum collision).
   */
  private async applyOne(
    client: PoolClient,
    file: MigrationFileRecord,
  ): Promise<MigrationRunStep | null> {
    // Dynamically require the migration module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file.filePath) as { default?: Migration } & Partial<Migration>;
    const migration: Migration = (mod.default ?? mod) as Migration;

    this.validateMigration(migration, file);

    const startedAt = Date.now();

    if (!migration.transactional) {
      return this.applyDdlMigration(client, file, migration, startedAt);
    }

    return this.applyTransactionalMigration(client, file, migration, startedAt);
  }

  /** Wraps up() in a SERIALIZABLE transaction with advisory lock and timeout. */
  private async applyTransactionalMigration(
    client: PoolClient,
    file: MigrationFileRecord,
    migration: Migration,
    startedAt: number,
  ): Promise<MigrationRunStep | null> {
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Advisory lock — released automatically at COMMIT/ROLLBACK.
      await this.lockManager.acquire(client, migration.affectedTables);

      // Hard cap on migration duration.
      await client.query(
        `SET LOCAL statement_timeout = ${this.maxDurationMs}`,
      );

      await migration.up(client);

      // Capture undo SQL from the down() function by building it as a string.
      // For TypeScript migrations, down() receives the client directly, so we
      // generate the undo representation by recording what down() would execute.
      // We store the migration version as the undo_sql key so rollbackTo() can
      // re-invoke down() against a live connection.
      const undoSql = await this.captureUndoSql(client, file, migration);

      await this.journal.append(client, {
        checksum: file.checksum,
        version: file.version,
        name: file.name,
        undoSql,
        affectedTables: migration.affectedTables,
        appliedAt: this.now(),
      });

      await client.query('COMMIT');

      const durationMs = Date.now() - startedAt;
      runnerMigrationDurationMs.observe(
        { version: file.version, direction: 'up', status: 'success' },
        durationMs,
      );
      runnerMigrationTotal.inc({ direction: 'up', status: 'success' });

      return { version: file.version, name: file.name, direction: 'up', durationMs };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);

      const durationMs = Date.now() - startedAt;
      runnerMigrationTotal.inc({ direction: 'up', status: 'failure' });
      runnerMigrationDurationMs.observe(
        { version: file.version, direction: 'up', status: 'failure' },
        durationMs,
      );

      // Attempt compensating rollback via down() on a fresh transaction.
      await this.attemptCompensation(client, file, migration);

      throw new Error(
        `MigrationRunner: migration ${file.version} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Applies a non-transactional DDL migration with pre-flight active-query check. */
  private async applyDdlMigration(
    client: PoolClient,
    file: MigrationFileRecord,
    migration: Migration,
    startedAt: number,
  ): Promise<MigrationRunStep | null> {
    // Phantom-read guard: ensure no concurrent queries are running against affected tables.
    await this.lockManager.assertNoActiveQueries(client, migration.affectedTables);

    // For DDL-only migrations we still record in the journal (using BEGIN/COMMIT
    // just for the journal write, not for the DDL itself).
    try {
      await migration.up(client);

      const undoSql = await this.captureUndoSql(client, file, migration);

      await client.query('BEGIN');
      await this.journal.append(client, {
        checksum: file.checksum,
        version: file.version,
        name: file.name,
        undoSql,
        affectedTables: migration.affectedTables,
        appliedAt: this.now(),
      });
      await client.query('COMMIT');

      const durationMs = Date.now() - startedAt;
      runnerMigrationDurationMs.observe(
        { version: file.version, direction: 'up', status: 'success' },
        durationMs,
      );
      runnerMigrationTotal.inc({ direction: 'up', status: 'success' });

      return { version: file.version, name: file.name, direction: 'up', durationMs };
    } catch (err) {
      runnerMigrationTotal.inc({ direction: 'up', status: 'failure' });
      runnerMigrationDurationMs.observe(
        { version: file.version, direction: 'up', status: 'failure' },
        Date.now() - startedAt,
      );
      throw new Error(
        `MigrationRunner: DDL migration ${file.version} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Captures undo SQL for a migration.
   *
   * For TypeScript migrations the undo representation is the migration's
   * version — rollbackTo() will reload the migration module and call down()
   * directly.  We store a sentinel comment plus the version so the journal
   * entry is self-describing and the rollback path can verify it.
   */
  private async captureUndoSql(
    _client: PoolClient,
    file: MigrationFileRecord,
    _migration: Migration,
  ): Promise<string> {
    // For TypeScript-based migrations, the "undo SQL" is the serialised
    // version reference.  rollbackTo() re-requires the module file and invokes
    // down() directly rather than executing raw SQL.
    return `-- undo:migration version=${file.version} file=${file.filePath}`;
  }

  /**
   * Attempts to run down() as a compensating action after up() fails.
   * Errors from down() are swallowed and logged — they must not mask the
   * original failure.
   */
  private async attemptCompensation(
    client: PoolClient,
    file: MigrationFileRecord,
    migration: Migration,
  ): Promise<void> {
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await migration.down(client);
      await client.query('COMMIT');
    } catch (compensationErr) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Compensation failure is non-fatal — the original error is already thrown.
      console.error(
        `MigrationRunner: compensation (down) for ${file.version} also failed: ` +
          (compensationErr as Error).message,
      );
    }
  }

  /**
   * Validates that a migration module export satisfies the Migration interface
   * and enforces the transactional/allowDdl invariant.
   */
  private validateMigration(migration: Migration, file: MigrationFileRecord): void {
    if (typeof migration.up !== 'function') {
      throw new Error(`Migration ${file.version}: missing up() export`);
    }
    if (typeof migration.down !== 'function') {
      throw new Error(`Migration ${file.version}: missing down() export`);
    }
    if (typeof migration.transactional !== 'boolean') {
      throw new Error(`Migration ${file.version}: missing transactional flag`);
    }
    if (!migration.transactional && migration.allowDdl !== true) {
      throw new Error(
        `Migration ${file.version}: non-transactional migration must set allowDdl: true`,
      );
    }
    if (!Array.isArray(migration.affectedTables) || migration.affectedTables.length === 0) {
      throw new Error(`Migration ${file.version}: affectedTables must be a non-empty array`);
    }
  }

  /**
   * Scans migrationsDir for files matching MIGRATION_FILENAME_REGEX, sorted
   * ascending by version (YYYYMMDD_HHMMSS).
   */
  async loadMigrationFiles(): Promise<MigrationFileRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.migrationsDir);
    } catch {
      return [];
    }

    return entries
      .filter((entry) => MIGRATION_FILENAME_REGEX.test(entry))
      .sort()
      .map((entry) => {
        const match = MIGRATION_FILENAME_REGEX.exec(entry)!;
        const version = match[1];
        const name = match[2];
        const filePath = path.join(this.migrationsDir, entry);
        const checksum = createHash('md5').update(filePath).digest('hex');
        return { version, name, filePath, checksum };
      });
  }

  /**
   * Returns the set of checksums for all migrations currently recorded as
   * applied (and not yet rolled back) in the journal.
   */
  private async loadAppliedChecksums(client: Pick<PoolClient, 'query'>): Promise<Set<string>> {
    const entries = await this.journal.listActive(client);
    return new Set(entries.map((e) => e.checksum));
  }
}

// ─── Rollback helper exported for CLI use ────────────────────────────────────

/**
 * Re-loads the migration module for a given journal entry's file path and
 * calls down() against the supplied client.
 *
 * Used by MigrationRunner.rollbackTo() to execute undo logic when the undo_sql
 * is a sentinel reference rather than raw SQL.
 */
export async function executeUndoFromSentinel(
  client: PoolClient,
  undoSql: string,
): Promise<void> {
  // Parse sentinel: -- undo:migration version=<v> file=<path>
  const match = undoSql.match(/file=(.+)$/);
  if (!match) {
    // Treat as raw SQL (future extensibility for SQL-based migrations).
    await client.query(undoSql);
    return;
  }
  const filePath = match[1].trim();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(filePath) as { default?: Migration } & Partial<Migration>;
  const migration: Migration = (mod.default ?? mod) as Migration;
  await migration.down(client);
}
