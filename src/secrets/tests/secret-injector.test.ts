import { describe, expect, it, vi } from 'vitest';
import { SecretInjector } from '../secret-injector';
import { LeaseManager } from '../lease-manager';

const config = {
  token: 'token',
  namespace: undefined,
  ageIdentityPath: undefined,
  address: 'http://vault:8200',
  role: 'test',
  secretMount: 'secret',
  databaseMount: 'database',
  dynamicDatabaseRole: 'app',
  dynamicDatabaseTtlSeconds: 86400,
  encryptedBackupPath: '.env.vault',
  maxSecretsPerPod: 256,
  staticCacheTtlMs: 300000,
  mappings: [
    { envKey: 'API_KEY', path: 'secret/data/api', field: 'apiKey', engine: 'kv-v2' as const },
    { envKey: 'PGUSER', path: 'database/creds/app', field: 'username', engine: 'database' as const },
  ],
};

describe('SecretInjector', () => {
  it('injects mapped values and tracks dynamic leases', async () => {
    const read = vi.fn(async (path: string) => path.includes('database')
      ? { data: { username: 'vault-user' }, leaseId: 'lease-db', leaseDuration: 86400, renewable: true }
      : { data: { apiKey: 'static-key' } });
    const vaultClient = { read } as any;
    const leaseManager = new LeaseManager(async () => ({ ttlSeconds: 86400, renewable: true }));
    const track = vi.spyOn(leaseManager, 'track');
    const injector = new SecretInjector(vaultClient, leaseManager, config);

    await injector.injectAtBoot();

    expect(process.env.API_KEY).toBe('static-key');
    expect(process.env.PGUSER).toBe('vault-user');
    expect(read).toHaveBeenCalledWith('secret/data/api', false);
    expect(track).toHaveBeenCalledWith('lease-db', 86400, true);
    leaseManager.stop();
  });
});
