import { DEFAULT_WEBHOOK_CONFIG } from '../config/webhooks';
import { WebhookDelivery } from './types';

const QUEUE_KEY = 'webhooks:deliveries:due';
const HASH_KEY = 'webhooks:deliveries:payloads';

export interface DeliveryQueueRedis {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, field: string): Promise<unknown>;
  hvals(key: string): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
  zcard(key: string): Promise<number>;
  zrangebyscore(key: string, min: number | string, max: number | string, ...args: (string | number)[]): Promise<string[]>;
}

export class DeliveryQueueFullError extends Error {
  constructor() { super('Webhook delivery queue capacity reached'); this.name = 'DeliveryQueueFullError'; }
}

export class DeliveryQueue {
  constructor(private readonly redis: DeliveryQueueRedis, private readonly maxPending = DEFAULT_WEBHOOK_CONFIG.maxPendingDeliveries) {}

  async enqueue(delivery: WebhookDelivery): Promise<void> {
    if ((await this.redis.zcard(QUEUE_KEY)) >= this.maxPending) throw new DeliveryQueueFullError();
    await this.redis.hset(HASH_KEY, delivery.id, JSON.stringify(delivery));
    await this.redis.zadd(QUEUE_KEY, delivery.nextRetryAt, delivery.id);
  }

  async popDue(now = Date.now(), limit = 100): Promise<WebhookDelivery[]> {
    const ids = await this.redis.zrangebyscore(QUEUE_KEY, 0, now, 'LIMIT', 0, limit);
    const deliveries: WebhookDelivery[] = [];
    for (const id of ids) {
      await this.redis.zrem(QUEUE_KEY, id);
      const raw = await this.redis.hget(HASH_KEY, id);
      if (raw) deliveries.push(JSON.parse(raw) as WebhookDelivery);
    }
    return deliveries;
  }

  async remove(id: string): Promise<void> { await this.redis.zrem(QUEUE_KEY, id); await this.redis.hdel(HASH_KEY, id); }
  async list(limit = 100): Promise<WebhookDelivery[]> { return (await this.redis.hvals(HASH_KEY)).slice(0, limit).map((r) => JSON.parse(r) as WebhookDelivery); }
  async depth(): Promise<number> { return this.redis.zcard(QUEUE_KEY); }
}
