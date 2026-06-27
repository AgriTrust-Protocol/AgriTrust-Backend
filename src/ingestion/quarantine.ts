export interface QuarantineEntry {
  topic: string;
  payload: string;
  schema_version: string;
  error: string;
  timestamp: string;
}

export interface RedisListClient {
  lpush(key: string, value: string): Promise<unknown>;
}

export class TelemetryQuarantine {
  constructor(
    private readonly redis: RedisListClient,
    private readonly key = 'telemetry:quarantine',
  ) {}

  async write(entry: Omit<QuarantineEntry, 'timestamp'>): Promise<void> {
    await this.redis.lpush(this.key, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }));
  }
}

export class InMemoryRedisList implements RedisListClient {
  readonly values: string[] = [];
  async lpush(_key: string, value: string): Promise<number> {
    this.values.unshift(value);
    return this.values.length;
  }
}
