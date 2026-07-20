import { createHash } from 'crypto';
import { PoolClient } from 'pg';

/**
 * AgriTrust Protocol – Migration Advisory Lock Manager
 *
 * Acquires PostgreSQL transaction-scoped advisory locks keyed on the set of
 * table names affected by a migration.  Using pg_advisory_xact_lock (rather
 * than the session-scoped pg_advisory_lock) ensures that the lock is
 * automatically released when the surrounding transaction commits or rolls
 * back — eliminating the risk of a stale lock after a runner crash.
 *
 * Lock key derivation
 * ───────────────────
 * PostgreSQL advisory-lock keys are 64-bit integers.  We derive a stable
 * 32-bit key from the sorted, concatenated table names by taking the first
 * 4 bytes of their MD5 digest and interpreting them as a big-endian unsigned
 * integer, then masking to the positive 31-bit range so the value is safe
 * as a signed PostgreSQL BIGINT.
 *
 * Phantom-read guard
 * ──────────────────
 * assertNoActiveQueries() checks pg_stat_activity for any backend that is
 * currently executing a query that references any of the affected tables.
 * This is used before non-transactional DDL migrations where the SERIALIZABLE
 * isolation level cannot protect against phantom reads.
 */

export interface LockManagerOptions {
  /** Milliseconds to wait for pg_advisory_xact_lock before timing out. */
  acquireTimeoutMs?: number;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;

export class LockManager {
  private readonly acquireTimeoutMs: number;

  constructor(options: LockManagerOptions = {}) {
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  }

  /**
   * Derives a stable 31-bit advisory lock key from a sorted list of table names.
   *
   * @param tableNames - The table names affected by the migration.
   * @returns A positive 31-bit integer suitable for pg_advisory_xact_lock.
   */
  static deriveKey(tableNames: string[]): number {
    const sorted = [...tableNames].sort().join(',');
    const digest = createHash('md5').update(sorted).digest();
    // Read first 4 bytes as big-endian uint32, mask to positive 31-bit range.
    const raw = digest.readUInt32BE(0);
    return raw & 0x7fffffff;
  }

  /**
   * Acquires a transaction-scoped advisory lock for all given table names.
   * The lock is released automatically when the surrounding transaction ends.
   *
   * Must be called inside an open transaction.
   *
   * @param client       - An active PoolClient already inside BEGIN.
   * @param tableNames   - Tables to lock.
   */
  async acquire(client: PoolClient, tableNames: string[]): Promise<void> {
    if (tableNames.length === 0) {
      throw new Error('LockManager.acquire: tableNames must not be empty');
    }

    const key = LockManager.deriveKey(tableNames);

    // Apply a statement timeout so we do not block indefinitely if another
    // migration is already holding the lock.
    await client.query('SET LOCAL lock_timeout = $1', [this.acquireTimeoutMs]);

    // pg_advisory_xact_lock is automatically released at transaction end.
    await client.query('SELECT pg_advisory_xact_lock($1)', [key]);
  }

  /**
   * Asserts that no active backend is currently executing a query that
   * references any of the supplied table names.
   *
   * Intended for non-transactional DDL migrations (e.g. CREATE INDEX
   * CONCURRENTLY) where we cannot rely on SERIALIZABLE isolation.
   *
   * @param client     - An active PoolClient (may or may not be in a transaction).
   * @param tableNames - Tables to check.
   * @throws Error if any active backend is querying a matching table.
   */
  async assertNoActiveQueries(client: PoolClient, tableNames: string[]): Promise<void> {
    if (tableNames.length === 0) return;

    // Build a LIKE pattern list — we do a simple substring check against the
    // query text.  This is a best-effort heuristic; it does not parse SQL but
    // is sufficient to block obviously conflicting DDL.
    const params: string[] = [];
    const conditions = tableNames.map((name, idx) => {
      params.push(`%${name}%`);
      return `query ILIKE $${idx + 1}`;
    });

    const result = await client.query<{ pid: number; query: string }>(
      `SELECT pid, query
         FROM pg_stat_activity
        WHERE state = 'active'
          AND pid <> pg_backend_pid()
          AND (${conditions.join(' OR ')})`,
      params,
    );

    if (result.rows.length > 0) {
      const pids = result.rows.map((r) => r.pid).join(', ');
      const tables = tableNames.join(', ');
      throw new Error(
        `LockManager: active queries detected on tables [${tables}] from PIDs [${pids}]. ` +
          'Refusing to apply non-transactional DDL migration while concurrent queries are running.',
      );
    }
  }
}
