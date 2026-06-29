import * as crypto from 'crypto';
import { KeyPurpose, KeyType, PgKeyStore } from './key-store';
import { KeyRotationOrchestrator } from './key-rotation-orchestrator';

export class KeySigner {
  constructor(
    private readonly keyStore: PgKeyStore,
    private readonly orchestrator: KeyRotationOrchestrator
  ) {}

  public async sign(purpose: KeyPurpose, data: string | Buffer): Promise<{ signature: string; fingerprint: string }> {
    const keyRecord = await this.keyStore.getCurrent(purpose);
    if (!keyRecord) {
      throw new Error(`No active key found for purpose: ${purpose}`);
    }

    const masterKey = process.env.KEY_ENCRYPTION_MASTER_KEY;
    if (!masterKey) {
      throw new Error('KEY_ENCRYPTION_MASTER_KEY environment variable is not set');
    }

    const privateKeyStr = this.orchestrator.decryptPrivateKey(keyRecord.encryptedPrivateKey, masterKey);

    let signature: string;

    if (keyRecord.type === KeyType.HMAC_SHA256) {
      signature = crypto.createHmac('sha256', privateKeyStr).update(data).digest('hex');
    } else {
      const privateKey = crypto.createPrivateKey(privateKeyStr);
      signature = crypto.sign(null, Buffer.from(data), privateKey).toString('hex');
    }

    return {
      signature,
      fingerprint: keyRecord.fingerprint,
    };
  }
}
