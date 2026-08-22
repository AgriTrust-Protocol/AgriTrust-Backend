import fs from 'fs';
import https from 'https';
import { Express } from 'express';
import { DeviceRegistry } from '../../devices/registry';
import { createMtlsAuthMiddleware } from './mtls_auth';

export interface MtlsServerConfig {
  serverKeyPath: string;
  serverCertPath: string;
  caCertPath: string;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
}

export function getMtlsServerConfigFromEnv(): MtlsServerConfig {
  const { MTLS_SERVER_KEY_PATH, MTLS_SERVER_CERT_PATH, MTLS_CA_CERT_PATH } = process.env;

  if (!MTLS_SERVER_KEY_PATH || !MTLS_SERVER_CERT_PATH || !MTLS_CA_CERT_PATH) {
    throw new Error(
      'MTLS_SERVER_KEY_PATH, MTLS_SERVER_CERT_PATH and MTLS_CA_CERT_PATH are required to start mTLS.',
    );
  }

  return {
    serverKeyPath: MTLS_SERVER_KEY_PATH,
    serverCertPath: MTLS_SERVER_CERT_PATH,
    caCertPath: MTLS_CA_CERT_PATH,
    requestCert: true,
    rejectUnauthorized: false,
  };
}

export function createMtlsServer(
  app: Express,
  registry: DeviceRegistry,
  config: MtlsServerConfig,
): https.Server {
  app.use(createMtlsAuthMiddleware(registry));

  const options: https.ServerOptions = {
    key: fs.readFileSync(config.serverKeyPath),
    cert: fs.readFileSync(config.serverCertPath),
    ca: fs.readFileSync(config.caCertPath),
    requestCert: config.requestCert ?? true,
    rejectUnauthorized: config.rejectUnauthorized ?? false,
    minVersion: 'TLSv1.2',
  };

  return https.createServer(options, app);
}
