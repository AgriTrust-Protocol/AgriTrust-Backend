import * as crypto from 'crypto';
import { Pool } from 'pg';
import { KeyPurpose, KeyType, KeyRecord, PgKeyStore } from './key-store';

export class KeyRotationOrchestrator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly checkIntervalMs: number = 60 * 60 * 1000; // Check every hour

  constructor(
    private readonly keyStore: PgKeyStore,
    private readonly pool: Pool
  ) {}

  public start(): void {
    if (this.timer) return;

    // Check every hour if it's 02:00 UTC
    this.timer = setInterval(async () => {
      const now = new Date();
      if (now.getUTCHours() === 2) {
        try {
          await this.rotateAllPurposesWithLock();
        } catch (err) {
          console.error('[KeyRotationOrchestrator] Scheduled rotation failed:', err);
        }
      }
    }, this.checkIntervalMs);

    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async rotateAllPurposesWithLock(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Use advisory lock to ensure only one instance rotates keys
      const lockKey = 123456789; // Unique key for key rotation lock
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) as acquired', [lockKey]);

      if (rows[0].acquired) {
        console.log('[KeyRotationOrchestrator] Acquired rotation lock. Starting rotation...');
        await this.rotateAllPurposes();
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        console.log('[KeyRotationOrchestrator] Rotation complete and lock released.');
      } else {
        console.log('[KeyRotationOrchestrator] Rotation lock already held by another instance. Skipping.');
      }
    } finally {
      client.release();
    }
  }

  public async rotateAllPurposes(): Promise<void> {
    const purposes = [
      KeyPurpose.ATTESTATION,
      KeyPurpose.CERTIFICATES,
      KeyPurpose.WEBHOOK,
    ];

    for (const purpose of purposes) {
      await this.rotateKey(purpose);
    }
  }

  public async rotateKey(purpose: KeyPurpose): Promise<KeyRecord> {
    const startTime = Date.now();
    const type = this.getKeyTypeForPurpose(purpose);
    const { publicKey, privateKey } = await this.generateKeyPair(type);

    // Fingerprint (SHA-256 of public key)
    const fingerprint = crypto.createHash('sha256').update(publicKey).digest('hex');

    const masterKey = process.env.KEY_ENCRYPTION_MASTER_KEY;
    if (!masterKey) {
      throw new Error('KEY_ENCRYPTION_MASTER_KEY environment variable is not set');
    }

    const encryptedPrivateKey = this.encryptPrivateKey(privateKey, masterKey);

    const newKey = await this.keyStore.rotate(purpose, {
      type,
      publicKey,
      encryptedPrivateKey,
      fingerprint,
    });

    const duration = Date.now() - startTime;
    if (duration > 100) {
      console.warn(`[KeyRotationOrchestrator] Key generation for ${purpose} took ${duration}ms (target < 100ms)`);
    }

    return newKey;
  }

  private getKeyTypeForPurpose(purpose: KeyPurpose): KeyType {
    switch (purpose) {
      case KeyPurpose.ATTESTATION:
        return KeyType.ED25519;
      case KeyPurpose.CERTIFICATES:
        return KeyType.ECDSA_P256;
      case KeyPurpose.WEBHOOK:
        return KeyType.HMAC_SHA256;
      default:
        throw new Error(`Unsupported purpose: ${purpose}`);
    }
  }

  private async generateKeyPair(type: KeyType): Promise<{ publicKey: string; privateKey: string }> {
    return new Promise((resolve, reject) => {
      if (type === KeyType.HMAC_SHA256) {
        const key = crypto.randomBytes(32).toString('hex');
        return resolve({ publicKey: 'hmac-sha256-symmetric', privateKey: key });
      }

      if (type === KeyType.ED25519) {
        crypto.generateKeyPair('ed25519', (err, publicKey, privateKey) => {
          if (err) return reject(err);
          resolve({
            publicKey: publicKey.export({ type: 'spki', format: 'pem' }) as string,
            privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
          });
        });
      } else if (type === KeyType.ECDSA_P256) {
        crypto.generateKeyPair('ec', { namedCurve: 'P-256' }, (err, publicKey, privateKey) => {
          if (err) return reject(err);
          resolve({
            publicKey: publicKey.export({ type: 'spki', format: 'pem' }) as string,
            privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
          });
        });
      }
    });
  }

  private encryptPrivateKey(privateKey: string, masterKey: string): string {
    const iv = crypto.randomBytes(16);
    const key = crypto.createHash('sha256').update(masterKey).digest();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  public decryptPrivateKey(encryptedData: string, masterKey: string): string {
    const [ivHex, encryptedHex] = encryptedData.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.createHash('sha256').update(masterKey).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
