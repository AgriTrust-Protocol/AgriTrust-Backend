import { RequestHandler } from 'express';

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

  const token = auth.slice('Bearer '.length).trim();
  const parts = token.split('.');
  if (parts.length < 2) return next();

  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    const tenantId = payload.tenant_id || payload.sub || null;
    let tier: 1 | 2 | 3 = 3;

    if (payload.tier) {
      const t = Number(payload.tier);
      if (t === 1 || t === 2 || t === 3) tier = t as 1 | 2 | 3;
    } else if (payload.role) {
      const role = String(payload.role).toLowerCase();
      if (role.includes('cooperative') || role.includes('inspector')) tier = 1;
      else if (role.includes('broker') || role.includes('processor')) tier = 2;
      else tier = 3;
    }

    if (tenantId) {
      (req as typeof req & { tenantContext?: { tenantId: string; tier: 1 | 2 | 3 } }).tenantContext = { tenantId: String(tenantId), tier };
    }
  } catch (e) {
    // ignore malformed tokens
  }

  return next();
};

export default authMiddleware;
