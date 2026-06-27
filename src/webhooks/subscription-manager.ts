import { randomUUID } from 'crypto';
import { WebhookSubscription } from './types';

const SUBS_KEY = 'webhooks:subscriptions';
export interface SubscriptionRedis { hset(key: string, field: string, value: string): Promise<unknown>; hvals(key: string): Promise<string[]>; }

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export class SubscriptionManager {
  constructor(private readonly redis: SubscriptionRedis) {}
  async register(input: { tenantId: string; url: string; eventTypes?: string[] }): Promise<WebhookSubscription> {
    const sub: WebhookSubscription = { id: randomUUID(), tenantId: input.tenantId, url: input.url, eventTypes: input.eventTypes?.length ? input.eventTypes : ['*'], createdAt: Date.now() };
    await this.redis.hset(SUBS_KEY, sub.id, JSON.stringify(sub));
    return sub;
  }
  async list(tenantId?: string): Promise<WebhookSubscription[]> {
    const subs = (await this.redis.hvals(SUBS_KEY)).map((r) => JSON.parse(r) as WebhookSubscription);
    return tenantId ? subs.filter((s) => s.tenantId === tenantId) : subs;
  }
  async matching(tenantId: string, eventType: string): Promise<WebhookSubscription[]> {
    return (await this.list(tenantId)).filter((s) => s.eventTypes.some((p) => globToRegex(p).test(eventType)));
  }
}
