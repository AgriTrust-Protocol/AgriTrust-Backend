import { DeadLetterWebhook, WebhookDelivery } from './types';

const DLQ_KEY = 'webhooks:dead-letter';
export interface DeadLetterRedis { lpush(key: string, value: string): Promise<unknown>; lrange(key: string, start: number, stop: number): Promise<string[]>; lrem(key: string, count: number, value: string): Promise<number>; }

export class DeadLetterQueue {
  constructor(private readonly redis: DeadLetterRedis) {}
  async add(delivery: WebhookDelivery, reason: string): Promise<DeadLetterWebhook> {
    const dead = { ...delivery, deadLetteredAt: Date.now(), reason };
    await this.redis.lpush(DLQ_KEY, JSON.stringify(dead));
    return dead;
  }
  async list(limit = 100): Promise<DeadLetterWebhook[]> { return (await this.redis.lrange(DLQ_KEY, 0, limit - 1)).map((r) => JSON.parse(r) as DeadLetterWebhook); }
  async remove(id: string): Promise<DeadLetterWebhook | null> {
    const all = await this.redis.lrange(DLQ_KEY, 0, -1);
    const raw = all.find((r) => (JSON.parse(r) as DeadLetterWebhook).id === id);
    if (!raw) return null;
    await this.redis.lrem(DLQ_KEY, 1, raw);
    return JSON.parse(raw) as DeadLetterWebhook;
  }
}
