import { Pool } from 'pg';

export interface DeviceRecord {
  deviceId: string;
  certSerial: string;
  certFingerprint: string;
  revoked: boolean;
  expiry: Date;
}

export class AuthError extends Error {
  public readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = 403;
  }
}

function normalizeHex(value: string): string {
  return value.replace(/^0x/i, '').replace(/[:\s]/g, '').toLowerCase();
}

const SELECT_DEVICE_BY_CERT = `
SELECT device_id AS "deviceId",
       cert_serial AS "certSerial",
       cert_fingerprint AS "certFingerprint",
       revoked,
       expiry
FROM devices
WHERE cert_serial = $1
  AND cert_fingerprint = $2
  AND revoked = false
  AND expiry > NOW()
LIMIT 1
`;

const UPSERT_DEVICE_CERT = `
INSERT INTO devices (device_id, cert_serial, cert_fingerprint, expiry)
VALUES ($1, $2, $3, $4)
ON CONFLICT (device_id) DO UPDATE
SET cert_serial = EXCLUDED.cert_serial,
    cert_fingerprint = EXCLUDED.cert_fingerprint,
    expiry = EXCLUDED.expiry,
    revoked = false,
    updated_at = NOW()
RETURNING device_id AS "deviceId",
          cert_serial AS "certSerial",
          cert_fingerprint AS "certFingerprint",
          revoked,
          expiry
`;

export class DeviceRegistry {
  private revokedSerials: Set<string> = new Set();

  async refreshRevokedSerials(): Promise<void> {
    const result = await this.pool.query<{ serial: string }>(`SELECT serial FROM cert_revocations`);
    this.revokedSerials = new Set(result.rows.map((row) => normalizeHex(row.serial)));
  }

  isRevokedByCrl(serialHex: string): boolean {
    return this.revokedSerials.has(normalizeHex(serialHex));
  }

  constructor(private readonly pool: Pool) {}

  async verifyDeviceCert(serialHex: string, fingerprint: string): Promise<DeviceRecord> {
    if (this.isRevokedByCrl(serialHex)) {
      throw new AuthError('Device certificate has been revoked');
    }

    const result = await this.pool.query<DeviceRecord>(SELECT_DEVICE_BY_CERT, [
      serialHex,
      fingerprint,
    ]);

    if (result.rowCount === 0 || !result.rows[0]) {
      throw new AuthError('Device certificate is not registered, has been revoked, or has expired');
    }

    return result.rows[0];
  }

  async registerDeviceCertificate(
    deviceId: string,
    serialHex: string,
    fingerprint: string,
    expiry: Date,
  ): Promise<DeviceRecord> {
    const result = await this.pool.query<DeviceRecord>(UPSERT_DEVICE_CERT, [
      deviceId,
      serialHex,
      fingerprint,
      expiry,
    ]);

    return result.rows[0];
  }
}
