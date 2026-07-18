import { CacheConfig, DEFAULT_CACHE_CONFIG } from '../config/cache';
import { recordCacheOperation } from './metrics';
import { CacheClient, CacheGetOptions, CacheSetOptions } from './types';

export class CacheService {
  constructor(private readonly client: CacheClient, private readonly config: CacheConfig = DEFAULT_CACHE_CONFIG) {}

  async getJson<T>(key: string, options: CacheGetOptions = {}): Promise<T | null> {
    if (!this.config.enabled) return null;
    const started = Date.now();
    try {
      const value = await this.withTimeout(this.client.get(this.scopedKey(key)));
      const result = value === null ? 'miss' : 'hit';
      recordCacheOperation('get', result, Date.now() - started);
      return value === null ? null : JSON.parse(value) as T;
    } catch {
      recordCacheOperation('get', options.critical ? 'critical_error' : 'error', Date.now() - started);
      return null;
    }
  }

  async setJson<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<boolean> {
    if (!this.config.enabled) return false;
    const ttlSeconds = options.ttlSeconds ?? (options.critical ? this.config.criticalPathTtlSeconds : this.config.defaultTtlSeconds);
    const started = Date.now();
    try {
      const result = await this.withTimeout(this.client.set(this.scopedKey(key), JSON.stringify(value), 'EX', ttlSeconds));
      recordCacheOperation('set', result === 'OK' ? 'ok' : 'skipped', Date.now() - started);
      return result === 'OK';
    } catch {
      recordCacheOperation('set', options.critical ? 'critical_error' : 'error', Date.now() - started);
      return false;
    }
  }

  async remember<T>(key: string, loader: () => Promise<T>, options: CacheSetOptions & CacheGetOptions = {}): Promise<T> {
    const cached = await this.getJson<T>(key, options);
    if (cached !== null) return cached;
    const value = await loader();
    await this.setJson(key, value, options);
    return value;
  }

  private scopedKey(key: string): string {
    return `${this.config.namespace}:${key}`;
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('cache operation timed out')), this.config.operationTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
