import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { TLSSocket, PeerCertificate } from 'tls';
import { Express, NextFunction, Request, Response } from 'express';
import { Counter, Gauge, Histogram, register } from 'prom-client';
import { CertificateTenantIdentity, farmIdFromCommonName, TenantResolver } from './tenant_resolver';

export interface GatewayTlsConfig {
  keyPath: string;
  certPath: string;
  clientCaPath: string;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
}

export const tlsHandshakeDurationMs = new Histogram({
  name: 'tls_handshake_duration_ms',
  help: 'Duration of mTLS handshakes observed by the API gateway in milliseconds',
  registers: [register],
});
export const certExpiryDaysRemaining = new Gauge({
  name: 'cert_expiry_days_remaining',
  help: 'Days remaining before the presented client certificate expires',
  labelNames: ['tenant_id', 'farm_id'],
  registers: [register],
});
export const tenantRequestsTotal = new Counter({
  name: 'tenant_requests_total',
  help: 'Requests accepted by tenant and role class',
  labelNames: ['tenant_id', 'farm_id', 'role_class'],
  registers: [register],
});

export function parseSubjectAltNames(subjectaltname?: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of subjectaltname?.split(/,\s*/) ?? []) {
    const [kind, ...rest] = entry.split(':');
    const value = rest.join(':').trim();
    if (!kind || !value) continue;
    const key = kind.toLowerCase();
    out[key] = [...(out[key] ?? []), value];
  }
  return out;
}

function sanValue(sans: Record<string, string[]>, key: string): string | undefined {
  return sans['uri']?.find((value) => value.startsWith(`${key}:`))?.slice(key.length + 1)
    ?? sans['dns']?.find((value) => value.startsWith(`${key}.`))?.split('.')[0];
}

export function extractTenantIdentity(peerCert: PeerCertificate): CertificateTenantIdentity {
  const commonName = typeof peerCert.subject?.CN === 'string' ? peerCert.subject.CN : '';
  const subjectAltNames = parseSubjectAltNames(peerCert.subjectaltname);
  return {
    commonName,
    farmId: sanValue(subjectAltNames, 'farm_id') ?? farmIdFromCommonName(commonName),
    tenantId: sanValue(subjectAltNames, 'tenant_id'),
    roles: (sanValue(subjectAltNames, 'role') ?? '').split('+').filter(Boolean),
    subjectAltNames,
  };
}

export function createMtlsTenantMiddleware(resolver: TenantResolver) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const started = Date.now();
    const socket = req.socket as TLSSocket;
    if (!socket.authorized) {
      res.status(403).json({ error: 'Client certificate validation failed', code: socket.authorizationError ?? 'CERT_UNAUTHORIZED' });
      return;
    }
    const peerCert = socket.getPeerCertificate(true) as PeerCertificate & { raw?: Buffer };
    if (!peerCert?.raw) {
      res.status(403).json({ error: 'Client certificate was not presented', code: 'CERT_MISSING' });
      return;
    }
    try {
      const identity = extractTenantIdentity(peerCert);
      const tenant = await resolver.resolve(identity);
      const expiryMs = new Date(peerCert.valid_to).getTime() - Date.now();
      certExpiryDaysRemaining.labels(tenant.tenantId, tenant.farmId).set(expiryMs / 86_400_000);
      tlsHandshakeDurationMs.observe(Date.now() - started);
      tenantRequestsTotal.labels(tenant.tenantId, tenant.farmId, tenant.rateLimitClass).inc();
      (req as Request & { tenantContext?: typeof tenant; clientCertificateFingerprint?: string }).tenantContext = tenant;
      (req as Request & { clientCertificateFingerprint?: string }).clientCertificateFingerprint = crypto.createHash('sha256').update(peerCert.raw).digest('hex');
      next();
    } catch (error) {
      const err = error as Error & { statusCode?: number; code?: string };
      res.status(err.statusCode ?? 403).json({ error: err.message, code: err.code ?? err.name });
    }
  };
}

export function createMtlsGatewayServer(app: Express, resolver: TenantResolver, config: GatewayTlsConfig): https.Server {
  app.use(createMtlsTenantMiddleware(resolver));
  return https.createServer({
    key: fs.readFileSync(config.keyPath),
    cert: fs.readFileSync(config.certPath),
    ca: fs.readFileSync(config.clientCaPath),
    requestCert: config.requestCert ?? true,
    rejectUnauthorized: config.rejectUnauthorized ?? true,
    minVersion: 'TLSv1.2',
  }, app);
}
