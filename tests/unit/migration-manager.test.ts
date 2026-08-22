import { mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MigrationManager } from '../../src/database/migration-manager';

async function makePool() {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true } as any);
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
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

async function makeMigrationsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-migrations-'));
  await writeFile(
    path.join(dir, '20260718000001_create_widgets.sql'),
    `
-- migrate:up
CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO widgets (id, name) VALUES ('w1', 'demo');
-- migrate:down
DROP TABLE widgets;
`,
  );
  await writeFile(
    path.join(dir, '20260718000002_add_widget_status.sql'),
    `
-- migrate:up
ALTER TABLE widgets ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
-- migrate:down
ALTER TABLE widgets DROP COLUMN status;
`,
  );
  return dir;
}

describe('MigrationManager', () => {
  it('applies pending migrations in version order and records checksums', async () => {
    const pool = await makePool();
    const migrationsDir = await makeMigrationsDir();
    const manager = new MigrationManager(pool as any, { migrationsDir });

    const result = await manager.up();

    expect(result.executed.map((step) => step.version)).toEqual([
      '20260718000001',
      '20260718000002',
    ]);
    const rows = await pool.query(
      'SELECT version, status, checksum FROM schema_migrations ORDER BY version',
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row: any) => row.status === 'applied')).toBe(true);
    expect(rows.rows[0].checksum).toMatch(/^[a-f0-9]{64}$/);
    const widgets = await pool.query('SELECT id, name, status FROM widgets');
    expect(widgets.rows[0]).toEqual({ id: 'w1', name: 'demo', status: 'active' });
    await pool.end();
  });

  it('rolls migrations back to a target version in reverse order', async () => {
    const pool = await makePool();
    const migrationsDir = await makeMigrationsDir();
    const manager = new MigrationManager(pool as any, { migrationsDir });

    await manager.up();
    const result = await manager.down('20260718000001');

    expect(result.executed).toEqual([
      { version: '20260718000002', name: 'add_widget_status', direction: 'down' },
    ]);
    const status = await manager.status();
    expect(status.find((row) => row.version === '20260718000002')?.status).toBe('rolled_back');
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'widgets'",
    );
    expect(columns.rows.map((row: any) => row.column_name)).not.toContain('status');
    await pool.end();
  });

  it('refuses rollback when a migration has no down section', async () => {
    const pool = await makePool();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agritrust-migrations-'));
    await writeFile(
      path.join(dir, '20260718000001_create_only_up.sql'),
      'CREATE TABLE only_up (id TEXT PRIMARY KEY);',
    );
    const manager = new MigrationManager(pool as any, { migrationsDir: dir });

    await manager.up();

    await expect(manager.down()).rejects.toThrow('missing -- migrate:down section');
    await pool.end();
  });
});
