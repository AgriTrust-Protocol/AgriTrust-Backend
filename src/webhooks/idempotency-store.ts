import { DEFAULT_WEBHOOK_CONFIG } from '../config/webhooks';

export interface IdempotencyRedis { set(key: string, value: string, mode: 'EX', ttl: number, nx: 'NX'): Promise<'OK' | null>; }

export class IdempotencyStore {
  constructor(private readonly redis: IdempotencyRedis, private readonly ttlSeconds = DEFAULT_WEBHOOK_CONFIG.idempotencyTtlSeconds) {}
  async markIfNew(idempotencyKey: string): Promise<boolean> {
    return (await this.redis.set(`webhooks:idempotency:${idempotencyKey}`, '1', 'EX', this.ttlSeconds, 'NX')) === 'OK';
  }
}
