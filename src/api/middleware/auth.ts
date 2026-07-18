import { RequestHandler } from 'express';

type TenantTier = 1 | 2 | 3;

function base64UrlDecode(str: string): string {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function normalizeTier(value: unknown): TenantTier {
  const numeric = Number(value);
  return numeric === 1 || numeric === 2 || numeric === 3 ? numeric : 3;
}

export const authMiddleware: RequestHandler = (req, _res, next) => {
  const auth = req.header('authorization') || req.header('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return next();
  }

  try {
    const [, payload] = auth.slice('Bearer '.length).split('.');
    if (!payload) return next();

    const claims = JSON.parse(base64UrlDecode(payload)) as {
      tenantId?: unknown;
      tenant_id?: unknown;
      tier?: unknown;
    };
    const tenantId = claims.tenantId ?? claims.tenant_id;

    if (tenantId) {
      req.tenantContext = { tenantId: String(tenantId), tier: normalizeTier(claims.tier) };
    }
  } catch {
    // Authentication verification is handled upstream; ignore malformed context claims here.
  }

  return next();
};

export default authMiddleware;
