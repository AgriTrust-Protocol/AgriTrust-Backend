import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgKeyStore, KeyPurpose, KeyPhase, KeyType } from '../../src/crypto/key-store';
import { KeyRotationOrchestrator } from '../../src/crypto/key-rotation-orchestrator';
import { KeySigner } from '../../src/crypto/key-signer';
import { KeyVerifier } from '../../src/crypto/key-verifier';

// Mock pg Pool
const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockPool = {
  query: mockQuery,
  connect: mockConnect,
} as any;

const mockClient = {
  query: mockQuery,
  release: vi.fn(),
};
mockConnect.mockResolvedValue(mockClient);

describe('Key Rotation System', () => {
  let keyStore: PgKeyStore;
  let orchestrator: KeyRotationOrchestrator;
  let signer: KeySigner;
  let verifier: KeyVerifier;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KEY_ENCRYPTION_MASTER_KEY = 'test-master-key-32-chars-long!!!!';
    keyStore = new PgKeyStore(mockPool);
    orchestrator = new KeyRotationOrchestrator(keyStore, mockPool);
    signer = new KeySigner(keyStore, orchestrator);
    verifier = new KeyVerifier(keyStore, orchestrator);
  });

  describe('KeyRotationOrchestrator', () => {
    it('should generate a new key within 100ms', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // Update existing keys
      mockQuery.mockResolvedValueOnce({ rows: [] }); // Audit Grace
      mockQuery.mockResolvedValueOnce({ // Insert new key
        rows: [{
          id: '1',
          purpose: KeyPurpose.ATTESTATION,
          type: KeyType.ED25519,
          public_key: 'mock-pub',
          encrypted_private_key: 'iv:mock-enc',
          phase: KeyPhase.ACTIVE,
          fingerprint: 'mock-fp',
          created_at: new Date()
        }]
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // Audit Active
      mockQuery.mockResolvedValueOnce({ rows: [] }); // Enforce max 2
      mockQuery.mockResolvedValueOnce({ rows: [] }); // Audit retire

      const start = Date.now();
      const key = await orchestrator.rotateKey(KeyPurpose.ATTESTATION);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);
      expect(key.purpose).toBe(KeyPurpose.ATTESTATION);
      expect(key.type).toBe(KeyType.ED25519);
    });

    it('should throw if KEY_ENCRYPTION_MASTER_KEY is missing', async () => {
      delete process.env.KEY_ENCRYPTION_MASTER_KEY;
      await expect(orchestrator.rotateKey(KeyPurpose.ATTESTATION)).rejects.toThrow('KEY_ENCRYPTION_MASTER_KEY environment variable is not set');
    });
  });

  describe('Phase Transitions', () => {
    it('should verify with both Active and Grace keys', async () => {
      const data = 'test-data';
      const masterKey = process.env.KEY_ENCRYPTION_MASTER_KEY!;
      const activeKey = {
        id: '2',
        purpose: KeyPurpose.WEBHOOK,
        type: KeyType.HMAC_SHA256,
        publicKey: 'hmac-sha256-symmetric',
        encryptedPrivateKey: orchestrator['encryptPrivateKey']('active-secret', masterKey),
        phase: KeyPhase.ACTIVE,
        fingerprint: 'fp-active'
      };
      const graceKey = {
        id: '1',
        purpose: KeyPurpose.WEBHOOK,
        type: KeyType.HMAC_SHA256,
        publicKey: 'hmac-sha256-symmetric',
        encryptedPrivateKey: orchestrator['encryptPrivateKey']('grace-secret', masterKey),
        phase: KeyPhase.GRACE,
        fingerprint: 'fp-grace'
      };

      // Mock getAllActive to return both
      mockQuery.mockResolvedValueOnce({
        rows: [
            { ...activeKey, public_key: activeKey.publicKey, encrypted_private_key: activeKey.encryptedPrivateKey, created_at: new Date() },
            { ...graceKey, public_key: graceKey.publicKey, encrypted_private_key: graceKey.encryptedPrivateKey, created_at: new Date() }
        ]
      });

      const activeSig = require('crypto').createHmac('sha256', 'active-secret').update(data).digest('hex');
      const graceSig = require('crypto').createHmac('sha256', 'grace-secret').update(data).digest('hex');

      expect(await verifier.verify(KeyPurpose.WEBHOOK, data, activeSig)).toBe(true);

      // Re-mock for second call
      mockQuery.mockResolvedValueOnce({
        rows: [
            { ...activeKey, public_key: activeKey.publicKey, encrypted_private_key: activeKey.encryptedPrivateKey, created_at: new Date() },
            { ...graceKey, public_key: graceKey.publicKey, encrypted_private_key: graceKey.encryptedPrivateKey, created_at: new Date() }
        ]
      });
      expect(await verifier.verify(KeyPurpose.WEBHOOK, data, graceSig)).toBe(true);
    });

    it('should reject Retired keys', async () => {
      const data = 'test-data';
      const masterKey = process.env.KEY_ENCRYPTION_MASTER_KEY!;
      const retiredKey = {
        id: '0',
        purpose: KeyPurpose.WEBHOOK,
        type: KeyType.HMAC_SHA256,
        publicKey: 'hmac-sha256-symmetric',
        encryptedPrivateKey: orchestrator['encryptPrivateKey']('retired-secret', masterKey),
        phase: KeyPhase.RETIRED,
        fingerprint: 'fp-retired'
      };

      // Mock getAllActive to return empty (since retired is not active/grace)
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const retiredSig = require('crypto').createHmac('sha256', 'retired-secret').update(data).digest('hex');
      expect(await verifier.verify(KeyPurpose.WEBHOOK, data, retiredSig)).toBe(false);
    });
  });
});
