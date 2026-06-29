  import { RequestHandler } from 'express';
// ─── Extend Express Request Interface ────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      tenantContext?: {
        tenantId: string;
        tier: 1 | 2 | 3; // Must precisely match the tier assignments used below
      };
      experimentContext?: {
        experimentId: string | null;
        variantName: string;
      };
    }
  }
}

function base64UrlDecode(str: string): string {
  // replace URL-safe chars
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

  export const authMiddleware: RequestHandler = (req, _res, next) => {
    const auth = req.header('authorization') || req.header('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return next();
    }

    if (tenantId) {
      (req as typeof req & { tenantContext?: { tenantId: string; tier: 1 | 2 | 3 } }).tenantContext = { tenantId: String(tenantId), tier };
    }

    return next();
  };

  export default authMiddleware;
