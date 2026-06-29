export class MemoryRedis {
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();
  private lists = new Map<string, string[]>();
  private strings = new Map<string, { value: string; expiresAt?: number }>();

  async hset(key: string, field: string, value: string): Promise<number> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
    return 1;
  }
  async hget(key: string, field: string): Promise<string | null> { return this.hashes.get(key)?.get(field) ?? null; }
  async hdel(key: string, field: string): Promise<number> { return this.hashes.get(key)?.delete(field) ? 1 : 0; }
  async hvals(key: string): Promise<string[]> { return [...(this.hashes.get(key)?.values() ?? [])]; }
  async zadd(key: string, score: number, member: string): Promise<number> {
    if (!this.sortedSets.has(key)) this.sortedSets.set(key, new Map());
    this.sortedSets.get(key)!.set(member, score);
    return 1;
  }
  async zrem(key: string, member: string): Promise<number> { return this.sortedSets.get(key)?.delete(member) ? 1 : 0; }
  async zcard(key: string): Promise<number> { return this.sortedSets.get(key)?.size ?? 0; }
  async zrangebyscore(key: string, min: number | string, max: number | string, ...args: (string | number)[]): Promise<string[]> {
    const minN = Number(min); const maxN = Number(max);
    let rows = [...(this.sortedSets.get(key)?.entries() ?? [])].filter(([, s]) => s >= minN && s <= maxN).sort((a, b) => a[1] - b[1]);
    const limitIndex = args.findIndex((a) => String(a).toUpperCase() === 'LIMIT');
    if (limitIndex >= 0) rows = rows.slice(Number(args[limitIndex + 1]), Number(args[limitIndex + 1]) + Number(args[limitIndex + 2]));
    return rows.map(([m]) => m);
  }
  async lpush(key: string, value: string): Promise<number> { const list = this.lists.get(key) ?? []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async lrange(key: string, start: number, stop: number): Promise<string[]> { const list = this.lists.get(key) ?? []; return list.slice(start, stop < 0 ? undefined : stop + 1); }
  async lrem(key: string, _count: number, value: string): Promise<number> { const list = this.lists.get(key) ?? []; const before = list.length; this.lists.set(key, list.filter((v) => v !== value)); return before - (this.lists.get(key)?.length ?? 0); }
  async set(key: string, value: string, mode?: string, ttl?: number, nx?: string): Promise<'OK' | null> {
    const existing = this.strings.get(key); if (existing?.expiresAt && existing.expiresAt <= Date.now()) this.strings.delete(key);
    if (nx === 'NX' && this.strings.has(key)) return null;
    this.strings.set(key, { value, expiresAt: mode === 'EX' && ttl ? Date.now() + ttl * 1000 : undefined }); return 'OK';
  }
}
