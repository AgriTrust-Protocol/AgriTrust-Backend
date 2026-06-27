import { describe, expect, it, vi } from 'vitest';
import { LeaseManager } from '../lease-manager';

describe('LeaseManager', () => {
  it('tracks leases without exposing secret values', () => {
    const manager = new LeaseManager(async () => ({ ttlSeconds: 10, renewable: true }));
    manager.track('database/creds/app/abc', 86400, true);

    expect(manager.getStatuses()).toEqual([
      expect.objectContaining({
        leaseId: 'database/creds/app/abc',
        ttlSeconds: expect.any(Number),
        renewable: true,
      }),
    ]);
    manager.stop();
  });

  it('renews at roughly 50 percent of the ttl', () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => ({ ttlSeconds: 20, renewable: true }));
    const manager = new LeaseManager(renew);

    manager.track('lease-1', 10, true);
    vi.advanceTimersByTime(4_999);
    expect(renew).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(renew).toHaveBeenCalledWith('lease-1', 10);

    manager.stop();
    vi.useRealTimers();
  });
});
