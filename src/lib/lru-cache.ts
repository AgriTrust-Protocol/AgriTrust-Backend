export class LRUCache<K, V> {
  private cache = new Map<K, { value: V; expiry: number | null }>();

  constructor(private maxEntries: number) {}

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      return undefined;
    }

    if (entry.expiry !== null && Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number | null = null): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    const expiry = ttlMs !== null ? Date.now() + ttlMs : null;
    this.cache.set(key, { value, expiry });

    if (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value as K | undefined;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      return false;
    }
    if (entry.expiry !== null && Date.now() > entry.expiry) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  clear(): void {
    this.cache.clear();
  }
}
