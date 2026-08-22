import { mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import {
  MigrationJournal,
  MAX_UNDO_BLOCKS,
  MAX_UNDO_BLOCK_BYTES,
} from '../../src/db/migrations/journal';
import { LockManager } from '../../src/db/migrations/lock-manager';
import { MigrationRunner, MIGRATION_FILENAME_REGEX } from '../../src/db/migrations/runner';

// ─── pg-mem pool factory ─────────────────────────────────────────────────────

async function makePool() {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true } as any);

  db.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer],
    returns: DataType.bool,
    implementation: () => true,
  });
  db.public.registerFunction({
    name: 'pg_advisory_lock',
    args: [DataType.integer],
    returns: DataType.bool,
    implementation: () => true,
  });
  db.public.registerFunction({
    name: 'pg_advisory_unlock',
    args: [DataType.integer],
    returns: DataType.bool,
    implementation: () => true,
  });
  db.public.registerFunction({
    name: 'pg_backend_pid',
    args: [],
    returns: DataType.integer,
    implementation: () => 0,
  });

  const { Pool } = db.adapters.createPg();
  return new Pool() as any;
}

// ─── LockManager ─────────────────────────────────────────────────────────────

describe('LockManager', () => {
  it('derives a stable non-negative key from table names', () => {
    const key1 = LockManager.deriveKey(['users', 'accounts']);
    const key2 = LockManager.deriveKey(['accounts', 'users']);
    expect(key1).toBe(key2);
    expect(key1).toBeGreaterThanOrEqual(0);
    expect(key1).toBeLessThanOrEqual(0x7fffffff);
  });

  it('returns different keys for different table sets', () => {
    const keyA = LockManager.deriveKey(['table_a']);
    const keyB = LockManager.deriveKey(['table_b']);
    expect(keyA).not.toBe(keyB);
  });

  it('throws when tableNames is empty', async () => {
    const pool = await makePool();
    const client = await pool.connect();
    const lm = new LockManager();
    await expect(lm.acquire(client, [])).rejects.toThrow('tableNames must not be empty');
    client.release();
    await pool.end();
  });

  it('acquires advisory lock without error via pg-mem stub', async () => {
    const pool = await makePool();
    const client = await pool.connect();
    await client.query('BEGIN');
    const lm = new LockManager();
    await expect(lm.acquire(client, ['widgets'])).resolves.toBeUndefined();
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  });
});

// ─── MigrationJournal ─────────────────────────────────────────────────────────

describe('MigrationJournal', () => {
  it('creates schema and appends an entry', async () => {
    const pool = await makePool();
    const client = await pool.connect();
    const journal = new MigrationJournal();

    await journal.ensureSchema(client);
    await journal.append(client, {
      checksum: 'abc123',
      version: '20260720_120000',
      name: 'create_test',
      undoSql: 'DROP TABLE test;',
      affectedTables: ['test'],
      appliedAt: new Date('2026-07-20T12:00:00Z'),
    });

    const entries = await journal.listActive(client);
    expect(entries).toHaveLength(1);
    expect(entries[0].checksum).toBe('abc123');
    expect(entries[0].version).toBe('20260720_120000');
    expect(entries[0].affectedTables).toEqual(['test']);

    client.release();
    await pool.end();
  });

  it('marks an entry as rolled back', async () => {
    const pool = await makePool();
    const client = await pool.connect();
    const journal = new MigrationJournal();

    await journal.ensureSchema(client);
    await journal.append(client, {
      checksum: 'def456',
      version: '20260720_130000',
      name: 'alter_users',
      undoSql: 'ALTER TABLE users DROP COLUMN extra;',
      affectedTables: ['users'],
      appliedAt: new Date(),
    });

    await journal.markRolledBack(client, '20260720_130000', new Date());
    const entries = await journal.listActive(client);
    expect(entries.find((e) => e.version === '20260720_130000')).toBeUndefined();

    client.release();
    await pool.end();
  });

  it('rejects undo_sql exceeding MAX_UNDO_BLOCK_BYTES', async () => {
    const pool = await makePool();
    const client = await pool.connect();
    const journal = new MigrationJournal();
    await journal.ensureSchema(client);

    const oversized = 'x'.repeat(MAX_UNDO_BLOCK_BYTES + 1);
    await expect(
      journal.append(client, {
        checksum: 'ghi789',
        version: '20260720_140000',
        name: 'oversized',
        undoSql: oversized,
        affectedTables: ['big_table'],
        appliedAt: new Date(),
      }),
    ).rejects.toThrow(`${MAX_UNDO_BLOCK_BYTES}-byte limit`);

    client.release();
    await pool.end();
  });

  it('rejects when MAX_UNDO_BLOCKS active entries are already present', async () => {
    const pool = await makePool();
    const client = await pool.connect();
    const journal = new MigrationJournal();
    await journal.ensureSchema(client);

    // Insert MAX_UNDO_BLOCKS entries directly to bypass the per-call check.
    for (let i = 0; i < MAX_UNDO_BLOCKS; i++) {
      const version = `20260720_${String(i).padStart(6, '0')}`;
      await client.query(
        `INSERT INTO _migration_journal (checksum, version, name, undo_sql, affected_tables, applied_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [`chk${i}`, version, `mig_${i}`, 'DROP TABLE foo;', ['foo']],
      );
    }

    await expect(
      journal.append(client, {
        checksum: 'overflow',
        version: '20260721_000000',
        name: 'overflow',
        undoSql: 'SELECT 1;',
        affectedTables: ['x'],
        appliedAt: new Date(),
      }),
    ).rejects.toThrow(`${MAX_UNDO_BLOCKS}`);

    client.release();
    await pool.end();
  });

  it('findByVersion returns null for unknown versions', async () => {
    const pool = await makePool();
    const client = await pool.connect();
    const journal = new MigrationJournal();
    await journal.ensureSchema(client);

    const entry = await journal.findByVersion(client, 'nonexistent_version');
    expect(entry).toBeNull();

    client.release();
    await pool.end();
  });
});

// ─── MIGRATION_FILENAME_REGEX ─────────────────────────────────────────────────

describe('MIGRATION_FILENAME_REGEX', () => {
  it('matches valid migration filenames', () => {
    expect(MIGRATION_FILENAME_REGEX.test('20260720_143000_create_widgets_table.ts')).toBe(true);
    expect(MIGRATION_FILENAME_REGEX.test('20260101_000000_initial_schema.ts')).toBe(true);
  });

  it('rejects invalid filenames', () => {
    expect(MIGRATION_FILENAME_REGEX.test('20260720_create_widgets.ts')).toBe(false);
    expect(MIGRATION_FILENAME_REGEX.test('20260720143000_create_widgets.ts')).toBe(false);
    expect(MIGRATION_FILENAME_REGEX.test('20260720_143000_CreateWidgets.ts')).toBe(false);
    expect(MIGRATION_FILENAME_REGEX.test('20260720_143000_create_widgets.sql')).toBe(false);
  });
});

// ─── MigrationRunner — loadMigrationFiles ─────────────────────────────────────

describe('MigrationRunner.loadMigrationFiles', () => {
  it('returns files sorted by version', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-runner-scan-'));
    await writeFile(path.join(dir, '20260720_143000_create_widgets.ts'), '');
    await writeFile(path.join(dir, '20260719_090000_create_users.ts'), '');
    await writeFile(path.join(dir, 'not_a_migration.ts'), '');

    const pool = await makePool();
    const runner = new MigrationRunner(pool, { migrationsDir: dir });
    const files = await runner.loadMigrationFiles();

    expect(files.map((f) => f.version)).toEqual(['20260719_090000', '20260720_143000']);
    await pool.end();
  });

  it('returns an empty array when directory does not exist', async () => {
    const pool = await makePool();
    const runner = new MigrationRunner(pool, {
      migrationsDir: path.join(os.tmpdir(), 'nonexistent_dir_agritrust_xyz123'),
    });
    const files = await runner.loadMigrationFiles();
    expect(files).toEqual([]);
    await pool.end();
  });
});

// ─── MigrationRunner — dryRun ─────────────────────────────────────────────────

describe('MigrationRunner.dryRun', () => {
  it('reports pending migrations without applying them', async () => {
    const pool = await makePool();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-dryrun-'));
    await writeFile(path.join(dir, '20260720_100000_create_orders.ts'), '// stub');

    const runner = new MigrationRunner(pool, { migrationsDir: dir });
    const result = await runner.dryRun();

    expect(result.dryRun).toBe(true);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].version).toBe('20260720_100000');
    expect(result.applied[0].direction).toBe('up');
    expect(result.applied[0].durationMs).toBe(0);

    await pool.end();
  });

  it('excludes already-applied checksums from dryRun results', async () => {
    const pool = await makePool();
    const client = await pool.connect();
    const journal = new MigrationJournal();
    await journal.ensureSchema(client);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-dryrun2-'));
    const filename = '20260720_110000_create_inventory.ts';
    await writeFile(path.join(dir, filename), '// stub');

    const { createHash } = await import('crypto');
    const checksum = createHash('md5').update(path.join(dir, filename)).digest('hex');
    await journal.append(client, {
      checksum,
      version: '20260720_110000',
      name: 'create_inventory',
      undoSql: '-- undo:migration version=20260720_110000 file=stub',
      affectedTables: ['inventory'],
      appliedAt: new Date(),
    });
    client.release();

    const runner = new MigrationRunner(pool, { migrationsDir: dir });
    const result = await runner.dryRun();

    expect(result.applied.find((s) => s.version === '20260720_110000')).toBeUndefined();
    await pool.end();
  });
});

// ─── MigrationRunner — contract validation ───────────────────────────────────

describe('MigrationRunner — migration contract validation', () => {
  it('rejects a migration missing the transactional flag', async () => {
    const pool = await makePool();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-validate-'));

    const filename = '20260720_150000_missing_flag.ts';
    // Write a plain JS CommonJS module; ts-node is not involved at runtime for require()
    await writeFile(
      path.join(dir, filename),
      [
        '"use strict";',
        'exports.up = async function() {};',
        'exports.down = async function() {};',
        'exports.affectedTables = ["x"];',
      ].join('\n'),
    );

    const runner = new MigrationRunner(pool, { migrationsDir: dir });
    await expect(runner.migrate()).rejects.toThrow('missing transactional flag');
    await pool.end();
  });

  it('rejects a non-transactional migration without allowDdl: true', async () => {
    const pool = await makePool();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-validate2-'));

    const filename = '20260720_160000_missing_allow_ddl.ts';
    await writeFile(
      path.join(dir, filename),
      [
        '"use strict";',
        'exports.up = async function() {};',
        'exports.down = async function() {};',
        'exports.transactional = false;',
        'exports.affectedTables = ["y"];',
      ].join('\n'),
    );

    const runner = new MigrationRunner(pool, { migrationsDir: dir });
    await expect(runner.migrate()).rejects.toThrow('allowDdl: true');
    await pool.end();
  });

  it('rejects a migration with an empty affectedTables array', async () => {
    const pool = await makePool();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-validate3-'));

    const filename = '20260720_170000_empty_tables.ts';
    await writeFile(
      path.join(dir, filename),
      [
        '"use strict";',
        'exports.up = async function() {};',
        'exports.down = async function() {};',
        'exports.transactional = true;',
        'exports.affectedTables = [];',
      ].join('\n'),
    );

    const runner = new MigrationRunner(pool, { migrationsDir: dir });
    await expect(runner.migrate()).rejects.toThrow('affectedTables must be a non-empty array');
    await pool.end();
  });
});

// ─── MigrationRunner — migrate() (transactional) ─────────────────────────────

describe('MigrationRunner.migrate', () => {
  it('applies a transactional migration and records it in the journal', async () => {
    const pool = await makePool();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-migrate-'));

    const filename = '20260720_180000_create_items.ts';
    await writeFile(
      path.join(dir, filename),
      [
        '"use strict";',
        'exports.transactional = true;',
        'exports.affectedTables = ["items"];',
        'exports.up = async function(client) {',
        '  await client.query("CREATE TABLE items (id TEXT PRIMARY KEY)");',
        '};',
        'exports.down = async function(client) {',
        '  await client.query("DROP TABLE IF EXISTS items");',
        '};',
      ].join('\n'),
    );

    const runner = new MigrationRunner(pool, { migrationsDir: dir });
    const result = await runner.migrate();

    expect(result.dryRun).toBe(false);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].version).toBe('20260720_180000');
    expect(result.applied[0].direction).toBe('up');
    expect(result.applied[0].durationMs).toBeGreaterThanOrEqual(0);

    // Verify the table was actually created
    const res = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'items'",
    );
    expect(res.rows).toHaveLength(1);

    // Verify journal entry written
    const client = await pool.connect();
    const journal = new MigrationJournal();
    const entries = await journal.listActive(client);
    client.release();
    expect(entries.find((e) => e.version === '20260720_180000')).toBeDefined();

    await pool.end();
  });

  it('skips an already-applied migration (idempotency)', async () => {
    const pool = await makePool();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-idempotent-'));

    const filename = '20260720_190000_create_tags.ts';
    await writeFile(
      path.join(dir, filename),
      [
        '"use strict";',
        'exports.transactional = true;',
        'exports.affectedTables = ["tags"];',
        'exports.up = async function(client) {',
        '  await client.query("CREATE TABLE tags (id TEXT PRIMARY KEY)");',
        '};',
        'exports.down = async function(client) {',
        '  await client.query("DROP TABLE IF EXISTS tags");',
        '};',
      ].join('\n'),
    );

    const runner = new MigrationRunner(pool, { migrationsDir: dir });
    await runner.migrate();

    // Second run — same migration should be skipped
    const result2 = await runner.migrate();
    expect(result2.applied).toHaveLength(0);

    await pool.end();
  });
});

// ─── MigrationRunner — rollbackTo ─────────────────────────────────────────────

describe('MigrationRunner.rollbackTo', () => {
  it('returns empty result when journal has no active entries', async () => {
    const pool = await makePool();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-rollback-'));
    const runner = new MigrationRunner(pool, { migrationsDir: dir });

    const result = await runner.rollbackTo();
    expect(result.applied).toHaveLength(0);
    await pool.end();
  });

  it('rolls back all entries after the target version using raw SQL undo blocks', async () => {
    const pool = await makePool();
    const client = await pool.connect();
    const journal = new MigrationJournal();
    await journal.ensureSchema(client);

    // Pre-create table so the DROP in undo_sql succeeds
    await client.query('CREATE TABLE IF NOT EXISTS orders_rb (id TEXT PRIMARY KEY)');

    await journal.append(client, {
      checksum: 'chk1',
      version: '20260719_090000',
      name: 'create_users',
      undoSql: 'SELECT 1',
      affectedTables: ['users_rb'],
      appliedAt: new Date('2026-07-19T09:00:00Z'),
    });
    await journal.append(client, {
      checksum: 'chk2',
      version: '20260720_100000',
      name: 'create_orders',
      undoSql: 'DROP TABLE IF EXISTS orders_rb',
      affectedTables: ['orders_rb'],
      appliedAt: new Date('2026-07-20T10:00:00Z'),
    });
    client.release();

    const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-rollback2-'));
    const runner = new MigrationRunner(pool, { migrationsDir: dir });

    // Roll back everything after '20260719_090000' — only '20260720_100000'
    const result = await runner.rollbackTo('20260719_090000');

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].version).toBe('20260720_100000');
    expect(result.applied[0].direction).toBe('down');

    const clientCheck = await pool.connect();
    const remaining = await journal.listActive(clientCheck);
    clientCheck.release();
    expect(remaining.find((e) => e.version === '20260719_090000')).toBeDefined();
    expect(remaining.find((e) => e.version === '20260720_100000')).toBeUndefined();

    await pool.end();
  });
});
