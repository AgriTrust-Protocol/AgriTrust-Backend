import { PoolConfig } from 'pg';
import { MonitoredPool } from '../database/connection_pool';
import { LeaseStatus } from './lease-manager';

export class RotatingPgPoolFactory {
  private current?: MonitoredPool;

  constructor(private readonly baseConfig: PoolConfig = {}) {}

  create(username: string, password: string): MonitoredPool {
    const previous = this.current;
    this.current = new MonitoredPool({
      ...this.baseConfig,
      user: username,
      password,
      connectionString: process.env.DATABASE_URL,
    });
    if (previous) setTimeout(() => void previous.end(), 30_000).unref?.();
    return this.current;
  }

  async handleLeaseRenewal(_lease: LeaseStatus): Promise<void> {
    // Vault renews the existing PostgreSQL role lease in-place; existing pools stay valid.
    // New dynamic credentials can be swapped by calling create() with a fresh Vault response.
  }

  get pool(): MonitoredPool | undefined {
    return this.current;
  }
}
