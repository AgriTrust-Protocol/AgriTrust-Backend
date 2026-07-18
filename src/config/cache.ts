export interface CacheConfig {
  enabled: boolean;
  namespace: string;
  defaultTtlSeconds: number;
  criticalPathTtlSeconds: number;
  redisUrl?: string;
  operationTimeoutMs: number;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadCacheConfig(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  return {
    enabled: env.CACHE_ENABLED !== 'false',
    namespace: env.CACHE_NAMESPACE ?? 'agritrust',
    defaultTtlSeconds: numberFromEnv('CACHE_DEFAULT_TTL_SECONDS', 300),
    criticalPathTtlSeconds: numberFromEnv('CACHE_CRITICAL_PATH_TTL_SECONDS', 60),
    redisUrl: env.REDIS_URL,
    operationTimeoutMs: numberFromEnv('CACHE_OPERATION_TIMEOUT_MS', 50),
  };
}

export const DEFAULT_CACHE_CONFIG = loadCacheConfig();
