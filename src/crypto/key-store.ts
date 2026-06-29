import { Pool } from 'pg';

export enum KeyPurpose {
  ATTESTATION = 'attestation',
  CERTIFICATES = 'certificates',
  WEBHOOK = 'webhook',
}

export enum KeyPhase {
  ACTIVE = 'Active',
  GRACE = 'Grace',
  RETIRED = 'Retired',
}

export enum KeyType {
  ED25519 = 'Ed25519',
  ECDSA_P256 = 'ECDSA_P256',
  HMAC_SHA256 = 'HMAC_SHA256',
}

export interface KeyRecord {
  id: string;
  purpose: KeyPurpose;
  type: KeyType;
  publicKey: string;
  encryptedPrivateKey: string;
  phase: KeyPhase;
  createdAt: Date;
  expiresAt: Date | null;
  fingerprint: string;
}

export class PgKeyStore {
  constructor(private readonly pool: Pool) {}

  async getCurrent(purpose: KeyPurpose): Promise<KeyRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM keys
       WHERE purpose = $1 AND phase = $2
       ORDER BY created_at DESC LIMIT 1`,
      [purpose, KeyPhase.ACTIVE]
    );
    return result.rows[0] ? this.mapRowToKeyRecord(result.rows[0]) : null;
  }

  async getAllActive(purpose: KeyPurpose): Promise<KeyRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM keys
       WHERE purpose = $1 AND phase IN ($2, $3)
       ORDER BY created_at DESC`,
      [purpose, KeyPhase.ACTIVE, KeyPhase.GRACE]
    );
    return result.rows.map(row => this.mapRowToKeyRecord(row));
  }

  async rotate(
    purpose: KeyPurpose,
    newKey: Omit<KeyRecord, 'id' | 'createdAt' | 'phase' | 'expiresAt'>,
    rotatedBy: string = 'system'
  ): Promise<KeyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Mark existing Active keys as Grace
      const gracePeriodHours = 72;
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + gracePeriodHours);

      const updateResult = await client.query(
        `UPDATE keys
         SET phase = $1, expires_at = $2
         WHERE purpose = $3 AND phase = $4
         RETURNING *`,
        [KeyPhase.GRACE, expiresAt, purpose, KeyPhase.ACTIVE]
      );

      // Audit transition to Grace
      for (const row of updateResult.rows) {
        await client.query(
          `INSERT INTO key_rotation_audit_log (key_id, purpose, phase, rotated_by, fingerprint)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.id, purpose, KeyPhase.GRACE, rotatedBy, row.fingerprint]
        );
      }

      // 2. Insert new Active key
      const insertResult = await client.query(
        `INSERT INTO keys (purpose, type, public_key, encrypted_private_key, phase, fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [purpose, newKey.type, newKey.publicKey, newKey.encryptedPrivateKey, KeyPhase.ACTIVE, newKey.fingerprint]
      );

      const createdKey = this.mapRowToKeyRecord(insertResult.rows[0]);

      // Audit new key
      await client.query(
        `INSERT INTO key_rotation_audit_log (key_id, purpose, phase, rotated_by, fingerprint)
         VALUES ($1, $2, $3, $4, $5)`,
        [createdKey.id, purpose, KeyPhase.ACTIVE, rotatedBy, createdKey.fingerprint]
      );

      // 3. ENFORCE MAX 2 CONCURRENT ACTIVE KEYS:
      // Retire any Grace keys beyond the one we just transitioned if we want to be strict,
      // but the requirement says "Maximum concurrent active keys per purpose: 2 (old and new during grace)".
      // This means when we rotate, the OLD ACTIVE becomes GRACE, and the NEW becomes ACTIVE.
      // Any PREVIOUS GRACE keys should be RETIRED immediately to maintain "max 2".

      const retireResult = await client.query(
        `UPDATE keys
         SET phase = $1, expires_at = NOW()
         WHERE purpose = $2 AND phase = $3 AND id NOT IN (
             SELECT id FROM keys
             WHERE purpose = $2 AND phase = $3
             ORDER BY created_at DESC LIMIT 1
         )
         RETURNING *`,
        [KeyPhase.RETIRED, purpose, KeyPhase.GRACE]
      );

      for (const row of retireResult.rows) {
        await client.query(
          `INSERT INTO key_rotation_audit_log (key_id, purpose, phase, rotated_by, fingerprint)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.id, purpose, KeyPhase.RETIRED, 'system_max_keys_enforcement', row.fingerprint]
        );
      }

      await client.query('COMMIT');
      return createdKey;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async retireExpiredKeys(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE keys
         SET phase = $1
         WHERE phase = $2 AND expires_at <= NOW()
         RETURNING *`,
        [KeyPhase.RETIRED, KeyPhase.GRACE]
      );

      // Audit transition to Retired
      for (const row of result.rows) {
        await client.query(
          `INSERT INTO key_rotation_audit_log (key_id, purpose, phase, rotated_by, fingerprint)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.id, row.purpose, KeyPhase.RETIRED, 'system_background_job', row.fingerprint]
        );
      }

      await client.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listKeys(): Promise<Omit<KeyRecord, 'encryptedPrivateKey'>[]> {
    const result = await this.pool.query(
      `SELECT id, purpose, type, public_key, phase, created_at, expires_at, fingerprint
       FROM keys
       ORDER BY created_at DESC`
    );
    return result.rows.map(row => ({
        id: row.id,
        purpose: row.purpose as KeyPurpose,
        type: row.type as KeyType,
        publicKey: row.public_key,
        phase: row.phase as KeyPhase,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        fingerprint: row.fingerprint
    }));
  }

  private mapRowToKeyRecord(row: any): KeyRecord {
    return {
      id: row.id,
      purpose: row.purpose as KeyPurpose,
      type: row.type as KeyType,
      publicKey: row.public_key,
      encryptedPrivateKey: row.encrypted_private_key,
      phase: row.phase as KeyPhase,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      fingerprint: row.fingerprint,
    };
  }
}
