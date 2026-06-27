import * as crypto from 'crypto';
import { KeyPurpose, KeyType, PgKeyStore } from './key-store';
import { KeyRotationOrchestrator } from './key-rotation-orchestrator';

export class KeyVerifier {
  constructor(
    private readonly keyStore: PgKeyStore,
    private readonly orchestrator: KeyRotationOrchestrator
  ) {}

  public async verify(
    purpose: KeyPurpose,
    data: string | Buffer,
    signature: string,
    fingerprint?: string
  ): Promise<boolean> {
    const activeKeys = await this.keyStore.getAllActive(purpose);

    // If fingerprint is provided, we can optimize by only checking that key
    const keysToCheck = fingerprint
      ? activeKeys.filter(k => k.fingerprint === fingerprint)
      : activeKeys;

    for (const keyRecord of keysToCheck) {
      let verified = false;

      if (keyRecord.type === KeyType.HMAC_SHA256) {
        const masterKey = process.env.KEY_ENCRYPTION_MASTER_KEY;
        if (!masterKey) {
            console.error('KEY_ENCRYPTION_MASTER_KEY not set');
            continue;
        }
        const key = this.orchestrator.decryptPrivateKey(keyRecord.encryptedPrivateKey, masterKey);
        const expectedSignature = crypto.createHmac('sha256', key).update(data).digest('hex');
        verified = crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'));
      } else {
        const publicKey = crypto.createPublicKey(keyRecord.publicKey);
        verified = crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(signature, 'hex'));
      }

      if (verified) return true;
    }

    return false;
  }
}
