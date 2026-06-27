import { Request, Response, NextFunction } from 'express';
import { KeyVerifier } from '../crypto/key-verifier';
import { KeyPurpose } from '../crypto/key-store';

export function createSignatureAuthMiddleware(keyVerifier: KeyVerifier, purpose: KeyPurpose) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const signature = req.header('X-Signature');
    const fingerprint = req.header('X-Key-Fingerprint');
    const timestamp = req.header('X-Timestamp');

    if (!signature || !timestamp) {
      return res.status(401).json({ error: 'Missing signature or timestamp' });
    }

    // Prevent replay attacks: timestamp must be within last 5 minutes
    const now = Date.now();
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(now - ts) > 5 * 60 * 1000) {
      return res.status(401).json({ error: 'Invalid or expired timestamp' });
    }

    // Construct data to verify (method + path + body + timestamp)
    const data = `${req.method}${req.path}${JSON.stringify(req.body)}${timestamp}`;

    try {
      const isValid = await keyVerifier.verify(purpose, data, signature, fingerprint);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
      next();
    } catch (err) {
      console.error('[SignatureAuth] Verification error:', err);
      res.status(500).json({ error: 'Internal server error during authentication' });
    }
  };
}
