import type { Pool } from 'pg';
import type { CircuitType, VerificationKeyRecord } from './types';

export interface VerificationKeyRegistry {
  put(record: Omit<VerificationKeyRecord, 'createdAt'> & { createdAt?: Date }): Promise<VerificationKeyRecord>;
  get(circuitType: CircuitType, seasonId: string): Promise<VerificationKeyRecord | undefined>;
}

export class PostgresVerificationKeyRegistry implements VerificationKeyRegistry {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS zkp_verification_keys (
        circuit_type TEXT NOT NULL,
        season_id TEXT NOT NULL,
        verification_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (circuit_type, season_id, version)
      )`);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS zkp_verification_keys_active_idx
      ON zkp_verification_keys (circuit_type, season_id)
      WHERE active = TRUE`);
  }

  async put(record: Omit<VerificationKeyRecord, 'createdAt'> & { createdAt?: Date }): Promise<VerificationKeyRecord> {
    const createdAt = record.createdAt ?? new Date();
    await this.pool.query(
      `INSERT INTO zkp_verification_keys
       (circuit_type, season_id, verification_key, version, active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (circuit_type, season_id, version) DO UPDATE
       SET verification_key = EXCLUDED.verification_key, active = EXCLUDED.active`,
      [record.circuitType, record.seasonId, record.verificationKey, record.version, record.active, createdAt],
    );
    return { ...record, createdAt };
  }

  async get(circuitType: CircuitType, seasonId: string): Promise<VerificationKeyRecord | undefined> {
    const result = await this.pool.query(
      `SELECT circuit_type, season_id, verification_key, version, active, created_at
       FROM zkp_verification_keys
       WHERE circuit_type = $1 AND season_id = $2 AND active = TRUE
       ORDER BY version DESC
       LIMIT 1`,
      [circuitType, seasonId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      circuitType: row.circuit_type,
      seasonId: row.season_id,
      verificationKey: row.verification_key,
      version: row.version,
      active: row.active,
      createdAt: row.created_at,
    };
  }
}

export class InMemoryVerificationKeyRegistry implements VerificationKeyRegistry {
  private readonly records = new Map<string, VerificationKeyRecord>();

  async put(record: Omit<VerificationKeyRecord, 'createdAt'> & { createdAt?: Date }): Promise<VerificationKeyRecord> {
    const stored = { ...record, createdAt: record.createdAt ?? new Date() };
    this.records.set(this.key(stored.circuitType, stored.seasonId, stored.version), stored);
    return stored;
  }

  async get(circuitType: CircuitType, seasonId: string): Promise<VerificationKeyRecord | undefined> {
    return [...this.records.values()]
      .filter((record) => record.circuitType === circuitType && record.seasonId === seasonId && record.active)
      .sort((a, b) => b.version - a.version)[0];
  }

  private key(circuitType: CircuitType, seasonId: string, version: number): string {
    return `${circuitType}:${seasonId}:${version}`;
  }
}
