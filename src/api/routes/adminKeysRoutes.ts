import { Router } from 'express';
import { KeyRotationOrchestrator } from '../../crypto/key-rotation-orchestrator';
import { PgKeyStore, KeyPurpose } from '../../crypto/key-store';

export function createAdminKeysRouter(
  orchestrator: KeyRotationOrchestrator,
  keyStore: PgKeyStore
): Router {
  const router = Router();

  /**
   * GET /admin/keys
   * Lists all keys (fingerprints only, never private material).
   */
  router.get('/', async (req, res) => {
    try {
      const keys = await keyStore.listKeys();
      res.json(keys);
    } catch (err) {
      console.error('[AdminKeys] Failed to list keys:', err);
      res.status(500).json({ error: 'Failed to list keys' });
    }
  });

  /**
   * POST /admin/keys/rotate
   * Manually triggers rotation for a specific purpose or all purposes.
   */
  router.post('/rotate', async (req, res) => {
    const { purpose } = req.body;

    try {
      if (purpose) {
        if (!Object.values(KeyPurpose).includes(purpose as KeyPurpose)) {
          return res.status(400).json({ error: `Invalid purpose: ${purpose}` });
        }
        const newKey = await orchestrator.rotateKey(purpose as KeyPurpose);
        return res.json({
          message: `Key rotated for ${purpose}`,
          fingerprint: newKey.fingerprint
        });
      } else {
        await orchestrator.rotateAllPurposes();
        return res.json({ message: 'All keys rotated' });
      }
    } catch (err) {
      console.error('[AdminKeys] Rotation failed:', err);
      res.status(500).json({ error: 'Key rotation failed' });
    }
  });

  return router;
}
