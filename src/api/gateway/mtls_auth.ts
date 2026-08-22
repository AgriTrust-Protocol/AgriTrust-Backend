import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { TLSSocket } from 'tls';
import { DeviceRegistry } from '../../devices/registry';

function normalizeHex(value: string): string {
  return value.replace(/^0x/i, '').replace(/[:\s]/g, '').toLowerCase();
}

function extractDeviceId(subject: Record<string, unknown> | undefined): string | null {
  if (!subject || typeof subject.CN !== 'string') {
    return null;
  }

  const cn = subject.CN.trim();
  if (cn.length === 0) {
    return null;
  }

  if (cn.includes('*')) {
    return null;
  }

  return cn;
}

export function createMtlsAuthMiddleware(registry: DeviceRegistry) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const socket = req.socket as TLSSocket;

    if (!socket.authorized) {
      const authError = socket.authorizationError ?? 'CERT_UNAUTHORIZED';
      res.status(403).json({
        error: 'Client certificate validation failed',
        code: authError,
      });
      return;
    }

    const peerCert = socket.getPeerCertificate(true) as any;
    if (!peerCert || !peerCert.raw) {
      res.status(403).json({
        error: 'Client certificate was not presented',
        code: 'CERT_MISSING',
      });
      return;
    }

    const serialHex = normalizeHex(peerCert.serialNumber ?? '');
    if (!serialHex) {
      res.status(403).json({
        error: 'Client certificate serial number is missing',
        code: 'CERT_SERIAL_MISSING',
      });
      return;
    }

    const fingerprint = crypto.createHash('sha256').update(peerCert.raw).digest('hex');
    const deviceId = extractDeviceId(peerCert.subject);

    if (!deviceId) {
      res.status(403).json({
        error: 'Client certificate does not contain a valid device identifier',
        code: 'CERT_CN_INVALID',
      });
      return;
    }

    try {
      await registry.verifyDeviceCert(serialHex, fingerprint);
      (req as Request & { device_id?: string }).device_id = deviceId;
      next();
    } catch (err) {
      const authErr = err as Error & { statusCode?: number };
      if (authErr.name === 'AuthError') {
        res.status(authErr.statusCode ?? 403).json({
          error: authErr.message,
          code: authErr.name,
        });
        return;
      }
      next(err);
    }
  };
}
