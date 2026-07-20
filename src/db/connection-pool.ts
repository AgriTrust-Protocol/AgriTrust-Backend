/**
 * AgriTrust Protocol – Database Connection Pool (re-export shim)
 *
 * The canonical PostgreSQL pool configuration lives in
 * `src/database/connection_pool.ts`.  This module re-exports everything
 * from that module so the migration runner package (`src/db/`) can import
 * the pool without a cross-package relative path.
 */
export {
  MonitoredPool,
  createMonitoredPool,
  type AdaptivePoolOptions,
  type PoolHealthSnapshot,
  type PoolHealthStatus,
} from '../database/connection_pool';
