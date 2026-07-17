export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: 'EX', ttlSeconds?: number): Promise<'OK' | null>;
  del?(key: string): Promise<number>;
}

export interface CacheSetOptions {
  ttlSeconds?: number;
  critical?: boolean;
}

export interface CacheGetOptions {
  critical?: boolean;
}
