import type { JSONSchemaType } from 'ajv';

export interface AppConfig {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  databaseUrl: string;
  databasePoolMin: number;
  databasePoolMax: number;
  mtlsEnabled: boolean;
  mtlsServerKeyPath?: string;
  mtlsServerCertPath?: string;
  mtlsCACertPath?: string;
  redisUrl: string;
  redisPoolMin: number;
  redisPoolMax: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'text' | 'json';
  openapiEnforcementMode: 'strict' | 'warning' | 'off';
  openapiSpecPaths: string[];
  uvThreadpoolSize: number;
  metricsPrefix: string;
  healthCheckIntervalMs: number;
  shutdownTimeoutMs: number;
  configDir: string;
  configFile: string;
  corsOrigins: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

export const configSchema: JSONSchemaType<AppConfig> = {
  type: 'object',
  properties: {
    port: { type: 'integer', minimum: 1, maximum: 65535, default: 3000 },
    nodeEnv: { type: 'string', enum: ['development', 'production', 'test'], default: 'development' },
    databaseUrl: { type: 'string', minLength: 1 },
    databasePoolMin: { type: 'integer', minimum: 0, maximum: 256, default: 2 },
    databasePoolMax: { type: 'integer', minimum: 1, maximum: 512, default: 20 },
    mtlsEnabled: { type: 'boolean', default: false },
    mtlsServerKeyPath: { type: 'string', nullable: true },
    mtlsServerCertPath: { type: 'string', nullable: true },
    mtlsCACertPath: { type: 'string', nullable: true },
    redisUrl: { type: 'string', default: 'redis://localhost:6379' },
    redisPoolMin: { type: 'integer', minimum: 0, maximum: 128, default: 2 },
    redisPoolMax: { type: 'integer', minimum: 1, maximum: 256, default: 10 },
    logLevel: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], default: 'info' },
    logFormat: { type: 'string', enum: ['text', 'json'], default: 'json' },
    openapiEnforcementMode: { type: 'string', enum: ['strict', 'warning', 'off'], default: 'strict' },
    openapiSpecPaths: {
      type: 'array',
      items: { type: 'string' },
      default: ['./src/openapi/v1.yaml', './src/openapi/v2.yaml'],
    },
    uvThreadpoolSize: { type: 'integer', minimum: 1, maximum: 128, default: 4 },
    metricsPrefix: { type: 'string', default: 'agritrust', minLength: 1 },
    healthCheckIntervalMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 30000 },
    shutdownTimeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 30000 },
    configDir: { type: 'string', default: './config' },
    configFile: { type: 'string', default: '' },
    corsOrigins: {
      type: 'array',
      items: { type: 'string' },
      default: ['*'],
    },
    rateLimitWindowMs: { type: 'integer', minimum: 100, maximum: 3600000, default: 60000 },
    rateLimitMax: { type: 'integer', minimum: 0, maximum: 100000, default: 100 },
  },
  required: ['databaseUrl'],
  additionalProperties: false,
};

export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'databaseUrl',
  'redisUrl',
  'mtlsServerKeyPath',
  'mtlsServerCertPath',
  'mtlsCACertPath',
]);

export function redactSensitiveValues(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_KEYS.has(key)) {
      const str = String(value);
      result[key] = str.length > 8
        ? str.slice(0, 4) + '****' + str.slice(-4)
        : '****';
    } else {
      result[key] = value;
    }
  }
  return result;
}
