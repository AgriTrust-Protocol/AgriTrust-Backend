export type SecretEngine = 'kv-v2' | 'database';

export interface SecretMapping {
  envKey: string;
  path: string;
  field?: string;
  engine: SecretEngine;
  cacheTtlMs?: number;
}

const DEFAULT_STATIC_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DYNAMIC_DB_TTL_SECONDS = 24 * 60 * 60;
const MAX_SECRETS_PER_POD = 256;

function parseSecretMappings(raw = process.env.VAULT_SECRET_MAPPINGS): SecretMapping[] {
  if (!raw) return [];
  const mappings = JSON.parse(raw) as SecretMapping[];
  if (!Array.isArray(mappings)) throw new Error('VAULT_SECRET_MAPPINGS must be a JSON array');
  if (mappings.length > MAX_SECRETS_PER_POD) {
    throw new Error(`VAULT_SECRET_MAPPINGS exceeds maximum of ${MAX_SECRETS_PER_POD} paths`);
  }
  return mappings.map((mapping) => ({
    ...mapping,
    cacheTtlMs: mapping.cacheTtlMs ?? (mapping.engine === 'kv-v2' ? DEFAULT_STATIC_CACHE_TTL_MS : undefined),
  }));
}

export const secretsConfig = {
  address: process.env.VAULT_ADDR ?? 'http://127.0.0.1:8200',
  token: process.env.VAULT_TOKEN,
  role: process.env.VAULT_ROLE ?? 'agritrust-backend',
  namespace: process.env.VAULT_NAMESPACE,
  secretMount: process.env.VAULT_KV_MOUNT ?? 'secret',
  databaseMount: process.env.VAULT_DATABASE_MOUNT ?? 'database',
  dynamicDatabaseRole: process.env.VAULT_DATABASE_ROLE ?? 'agritrust-postgres',
  dynamicDatabaseTtlSeconds: Number(process.env.VAULT_DYNAMIC_DB_TTL_SECONDS ?? DEFAULT_DYNAMIC_DB_TTL_SECONDS),
  encryptedBackupPath: process.env.VAULT_BACKUP_PATH ?? '.env.vault',
  ageIdentityPath: process.env.VAULT_AGE_IDENTITY_PATH,
  maxSecretsPerPod: MAX_SECRETS_PER_POD,
  staticCacheTtlMs: DEFAULT_STATIC_CACHE_TTL_MS,
  mappings: parseSecretMappings(),
};
