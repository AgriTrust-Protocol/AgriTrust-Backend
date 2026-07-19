import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';

export type MigrationDirection = 'up' | 'down';
export type MigrationStatus = 'applied' | 'rolled_back';

export interface MigrationFile {
  version: string;
  name: string;
  upSql: string;
  downSql?: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
  rolledBackAt: Date | null;
  status: MigrationStatus;
}

export interface MigrationPlanStep {
  version: string;
  name: string;
  direction: MigrationDirection;
}

export interface MigrationRunnerOptions {
  migrationsDir?: string;
  lockKey?: number;
  statementTimeoutMs?: number;
  now?: () => Date;
}

export interface MigrationResult {
  direction: MigrationDirection;
  executed: MigrationPlanStep[];
}

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DEFAULT_LOCK_KEY = 3_410_108;

export const migrationDurationMs = new Histogram({
  name: 'database_migration_duration_ms',
  help: 'Database migration execution duration in milliseconds',
  labelNames: ['direction', 'version', 'status'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000],
  registers: [metricsRegistry],
});

export const migrationExecutionsTotal = new Counter({
  name: 'database_migration_executions_total',
  help: 'Total database migration executions by direction and status',
  labelNames: ['direction', 'status'] as const,
  registers: [metricsRegistry],
});

export const migrationCurrentVersion = new Gauge({
  name: 'database_migration_current_version',
  help: 'Highest currently applied database migration version',
  registers: [metricsRegistry],
});

export class MigrationManager {
  private readonly migrationsDir: string;
  private readonly lockKey: number;
  private readonly statementTimeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, options: MigrationRunnerOptions = {}) {
    this.migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    this.lockKey = options.lockKey ?? DEFAULT_LOCK_KEY;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  async up(targetVersion?: string): Promise<MigrationResult> {
    return this.withMigrationLock(async (client) => {
      await this.ensureSchema(client);
      const files = await this.loadMigrations();
      const applied = await this.getAppliedMap(client);
      const pending = files.filter((file) => !applied.has(file.version));
      const selected = targetVersion ? pending.filter((file) => file.version <= targetVersion) : pending;
      const executed: MigrationPlanStep[] = [];

      for (const file of selected) {
        await this.executeInTransaction(client, file, 'up', file.upSql);
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at, status)
           VALUES ($1, $2, $3, $4, 'applied')
           ON CONFLICT (version) DO UPDATE
             SET name = EXCLUDED.name,
                 checksum = EXCLUDED.checksum,
                 applied_at = EXCLUDED.applied_at,
                 rolled_back_at = NULL,
                 status = 'applied'`,
          [file.version, file.name, file.checksum, this.now()],
        );
        executed.push({ version: file.version, name: file.name, direction: 'up' });
      }

      await this.publishCurrentVersion(client);
      return { direction: 'up', executed };
    });
  }

  async down(targetVersion?: string): Promise<MigrationResult> {
    return this.withMigrationLock(async (client) => {
      await this.ensureSchema(client);
      const files = await this.loadMigrations();
      const fileByVersion = new Map(files.map((file) => [file.version, file]));
      const applied = await this.getAppliedMigrations(client);
      const selected = applied
        .filter((row) => !targetVersion || row.version > targetVersion)
        .sort((a, b) => b.version.localeCompare(a.version));
      const executed: MigrationPlanStep[] = [];

      for (const row of selected) {
        const file = fileByVersion.get(row.version);
        if (!file) throw new Error(`Cannot rollback ${row.version}: migration file is missing`);
        if (file.checksum !== row.checksum) throw new Error(`Cannot rollback ${row.version}: checksum mismatch`);
        if (!file.downSql?.trim()) throw new Error(`Cannot rollback ${row.version}: missing -- migrate:down section`);
        await this.executeInTransaction(client, file, 'down', file.downSql);
        await client.query(
          `UPDATE schema_migrations
              SET rolled_back_at = $2, status = 'rolled_back'
            WHERE version = $1`,
          [file.version, this.now()],
        );
        executed.push({ version: file.version, name: file.name, direction: 'down' });
      }

      await this.publishCurrentVersion(client);
      return { direction: 'down', executed };
    });
  }

  async status(): Promise<AppliedMigration[]> {
    return this.withMigrationLock(async (client) => {
      await this.ensureSchema(client);
      return this.getAppliedMigrations(client, true);
    });
  }

  async plan(direction: MigrationDirection, targetVersion?: string): Promise<MigrationPlanStep[]> {
    await this.ensureSchema(this.pool as unknown as PoolClient);
    const files = await this.loadMigrations();
    const applied = await this.getAppliedMigrations(this.pool as unknown as PoolClient);
    const appliedVersions = new Set(applied.map((row) => row.version));

    if (direction === 'up') {
      return files
        .filter((file) => !appliedVersions.has(file.version))
        .filter((file) => !targetVersion || file.version <= targetVersion)
        .map((file) => ({ version: file.version, name: file.name, direction }));
    }

    return applied
      .filter((row) => !targetVersion || row.version > targetVersion)
      .sort((a, b) => b.version.localeCompare(a.version))
      .map((row) => ({ version: row.version, name: row.name, direction }));
  }

  private async withMigrationLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [this.lockKey]);
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [this.lockKey]).catch(() => undefined);
      client.release();
    }
  }

  private async ensureSchema(client: Pick<PoolClient, 'query'>): Promise<void> {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rolled_back_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'rolled_back'))
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_schema_migrations_status_version ON schema_migrations (status, version)');
  }

  private async executeInTransaction(client: PoolClient, file: MigrationFile, direction: MigrationDirection, sql: string): Promise<void> {
    const startedAt = Date.now();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL lock_timeout = $1', [this.statementTimeoutMs]);
      await client.query('SET LOCAL statement_timeout = $1', [this.statementTimeoutMs]);
      await client.query(sql);
      await client.query('COMMIT');
      migrationExecutionsTotal.inc({ direction, status: 'success' });
      migrationDurationMs.observe({ direction, version: file.version, status: 'success' }, Date.now() - startedAt);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      migrationExecutionsTotal.inc({ direction, status: 'failure' });
      migrationDurationMs.observe({ direction, version: file.version, status: 'failure' }, Date.now() - startedAt);
      throw error;
    }
  }

  private async loadMigrations(): Promise<MigrationFile[]> {
    const entries = await fs.readdir(this.migrationsDir);
    return Promise.all(entries.filter((entry) => entry.endsWith('.sql')).sort().map(async (entry) => {
      const fullPath = path.join(this.migrationsDir, entry);
      const raw = await fs.readFile(fullPath, 'utf8');
      const [upSql, downSql] = raw.split(/^--\s*migrate:down\s*$/im);
      const match = entry.match(/^(\d+)_(.+)\.sql$/);
      if (!match) throw new Error(`Invalid migration filename: ${entry}`);
      return {
        version: match[1],
        name: match[2],
        upSql: upSql.replace(/^--\s*migrate:up\s*$/im, '').trim(),
        downSql: downSql?.trim(),
        checksum: createHash('sha256').update(raw).digest('hex'),
      };
    }));
  }

  private async getAppliedMap(client: PoolClient): Promise<Map<string, AppliedMigration>> {
    return new Map((await this.getAppliedMigrations(client)).map((row) => [row.version, row]));
  }

  private async getAppliedMigrations(client: Pick<PoolClient, 'query'>, includeRolledBack = false): Promise<AppliedMigration[]> {
    const result = await client.query(
      `SELECT version, name, checksum, applied_at, rolled_back_at, status
         FROM schema_migrations
        ${includeRolledBack ? '' : "WHERE status = 'applied'"}
        ORDER BY version ASC`,
    );
    return result.rows.map((row: any) => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
      rolledBackAt: row.rolled_back_at,
      status: row.status,
    }));
  }

  private async publishCurrentVersion(client: Pick<PoolClient, 'query'>): Promise<void> {
    const result = await client.query("SELECT COALESCE(MAX(version), '0') AS version FROM schema_migrations WHERE status = 'applied'");
    migrationCurrentVersion.set(Number(result.rows[0]?.version ?? 0));
  }
}
