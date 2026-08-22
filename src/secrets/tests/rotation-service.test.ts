import { describe, expect, it, vi, afterEach } from 'vitest';
import { metricsRegistry } from '../../api/metrics/registry';
import { LeaseManager } from '../lease-manager';
import { SecretRotationService } from '../rotation-service';

describe('SecretRotationService', () => {
  afterEach(() => {
    metricsRegistry.resetMetrics();
    delete process.env.WEBHOOK_API_KEY;
  });

  it('rotates database credentials after canary validation and tracks the lease under 100ms', async () => {
    let now = 1_000;
    const vaultClient = {
      read: vi.fn(async () => ({
        data: { username: 'vault-user', password: 'vault-pass' },
        leaseId: 'lease-db',
        leaseDuration: 3600,
        renewable: true,
      })),
    } as any;
    const leaseManager = new LeaseManager(async () => ({ ttlSeconds: 3600, renewable: true }));
    const track = vi.spyOn(leaseManager, 'track');
    const pgPoolFactory = { create: vi.fn() } as any;
    const service = new SecretRotationService(vaultClient, leaseManager, pgPoolFactory, () => now);
    const canary = vi.fn(async () => {
      now += 25;
    });

    const result = await service.rotate({
      name: 'primary-postgres',
      type: 'database',
      path: 'database/creds/agritrust',
      intervalMs: 3_600_000,
      canary,
    });

    expect(result.durationMs).toBeLessThan(100);
    expect(canary).toHaveBeenCalledWith({ username: 'vault-user', password: 'vault-pass' });
    expect(pgPoolFactory.create).toHaveBeenCalledWith('vault-user', 'vault-pass');
    expect(track).toHaveBeenCalledWith('lease-db', 3600, true);
    expect(await metricsRegistry.metrics()).toContain(
      'secret_rotation_attempts_total{target="primary-postgres",type="database",result="success"} 1',
    );
    leaseManager.stop();
  });

  it('rotates API key environment variables without logging secret values', async () => {
    const vaultClient = { read: vi.fn(async () => ({ data: { apiKey: 'new-key' } })) } as any;
    const service = new SecretRotationService(
      vaultClient,
      new LeaseManager(async () => ({ ttlSeconds: 1, renewable: false })),
      undefined,
      () => 2_000,
    );

    await service.rotate({
      name: 'webhook-api-key',
      type: 'api-key',
      path: 'secret/data/webhooks',
      envKey: 'WEBHOOK_API_KEY',
      field: 'apiKey',
      intervalMs: 900_000,
    });

    expect(process.env.WEBHOOK_API_KEY).toBe('new-key');
    expect(await metricsRegistry.metrics()).not.toContain('new-key');
  });

  it('records failures and does not swap credentials when canary fails', async () => {
    const vaultClient = {
      read: vi.fn(async () => ({ data: { username: 'bad', password: 'bad' } })),
    } as any;
    const pgPoolFactory = { create: vi.fn() } as any;
    const service = new SecretRotationService(
      vaultClient,
      new LeaseManager(async () => ({ ttlSeconds: 1, renewable: false })),
      pgPoolFactory,
    );

    await expect(
      service.rotate({
        name: 'primary-postgres',
        type: 'database',
        path: 'database/creds/agritrust',
        intervalMs: 3_600_000,
        canary: async () => {
          throw new Error('canary failed');
        },
      }),
    ).rejects.toThrow('canary failed');

    expect(pgPoolFactory.create).not.toHaveBeenCalled();
    expect(await metricsRegistry.metrics()).toContain(
      'secret_rotation_attempts_total{target="primary-postgres",type="database",result="failure"} 1',
    );
  });
});
