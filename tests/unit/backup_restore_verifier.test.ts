import { describe, expect, it, vi } from 'vitest';
import {
  BackupRestoreVerifier,
  BackupCatalog,
  RestoreSandbox,
} from '../../src/database/backup/restore_verifier';

const backup = {
  id: 'backup-2026-07-17',
  location: 's3://agritrust/backups/latest.dump',
  takenAt: new Date('2026-07-17T00:00:00Z'),
};

function createHarness(queryRows: unknown[][] = [[{ version: '1' }]]) {
  const catalog: BackupCatalog = { getLatestBackup: vi.fn().mockResolvedValue(backup) };
  const sandbox: RestoreSandbox = {
    restore: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(async (_db: string, _sql: string) => queryRows.shift() ?? []),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  return { catalog, sandbox };
}

describe('BackupRestoreVerifier', () => {
  it('restores the latest backup into an isolated sandbox and records passing checks', async () => {
    const { catalog, sandbox } = createHarness([[{ version: '20260717000000' }], []]);
    const verifier = new BackupRestoreVerifier({
      catalog,
      sandbox,
      checks: [
        {
          name: 'schema_migrations',
          sql: 'SELECT version FROM schema_migrations LIMIT 1',
          minRows: 1,
        },
        { name: 'certificates_readable', sql: 'SELECT id FROM certificates LIMIT 1', minRows: 0 },
      ],
      now: vi
        .fn()
        .mockReturnValueOnce(new Date('2026-07-17T01:00:00Z'))
        .mockReturnValueOnce(new Date('2026-07-17T01:00:01Z')),
      sandboxDatabasePrefix: 'verify_test',
    });

    const result = await verifier.verifyLatest();

    expect(result.status).toBe('passed');
    expect(result.backupId).toBe(backup.id);
    expect(result.durationMs).toBe(1000);
    expect(result.sandboxDatabase).toMatch(/^verify_test_/);
    expect(sandbox.restore).toHaveBeenCalledWith(backup, result.sandboxDatabase);
    expect(sandbox.destroy).toHaveBeenCalledWith(result.sandboxDatabase);
    expect(result.checks).toEqual([
      { name: 'schema_migrations', rows: 1, passed: true },
      { name: 'certificates_readable', rows: 0, passed: true },
    ]);
  });

  it('returns failed and still destroys the sandbox when a check fails', async () => {
    const { catalog, sandbox } = createHarness([[]]);
    const verifier = new BackupRestoreVerifier({
      catalog,
      sandbox,
      checks: [{ name: 'required_rows', sql: 'SELECT 1 WHERE false', minRows: 1 }],
    });

    const result = await verifier.verifyLatest();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('required_rows');
    expect(sandbox.destroy).toHaveBeenCalledWith(result.sandboxDatabase);
  });

  it('fails safely when no backup candidate exists', async () => {
    const catalog: BackupCatalog = { getLatestBackup: vi.fn().mockResolvedValue(null) };
    const sandbox: RestoreSandbox = {
      restore: vi.fn(),
      query: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const verifier = new BackupRestoreVerifier({ catalog, sandbox, checks: [] });

    const result = await verifier.verifyLatest();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No database backup candidate');
    expect(sandbox.restore).not.toHaveBeenCalled();
    expect(sandbox.destroy).toHaveBeenCalledWith(result.sandboxDatabase);
  });
});
