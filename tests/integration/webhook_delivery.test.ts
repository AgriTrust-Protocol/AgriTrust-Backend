import { createServer, Server } from 'http';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WEBHOOK_CONFIG } from '../../src/config/webhooks';
import { DeadLetterQueue } from '../../src/webhooks/dead-letter-queue';
import { DeliveryQueue } from '../../src/webhooks/delivery-queue';
import { WebhookDispatcher } from '../../src/webhooks/dispatcher';
import { IdempotencyStore } from '../../src/webhooks/idempotency-store';
import { MemoryRedis } from '../../src/webhooks/memory-redis';

async function mockServer(statuses: number[]): Promise<{ url: string; close: () => Promise<void>; count: () => number; headers: () => Record<string, string | string[] | undefined> }> {
  let attempts = 0;
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  const server: Server = createServer((req, res) => { attempts += 1; lastHeaders = req.headers; res.statusCode = statuses[Math.min(attempts - 1, statuses.length - 1)]; res.end('ok'); });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return { url: `http://127.0.0.1:${address.port}/hook`, close: () => new Promise<void>((resolve) => server.close(() => resolve())), count: () => attempts, headers: () => lastHeaders };
}

describe('WebhookDispatcher', () => {
  it('retries 5xx responses and sends idempotency headers', async () => {
    const server = await mockServer([500, 200]);
    const redis = new MemoryRedis();
    const dispatcher = new WebhookDispatcher(new DeliveryQueue(redis), new IdempotencyStore(redis), new DeadLetterQueue(redis), { ...DEFAULT_WEBHOOK_CONFIG, requestTimeoutMs: 250, workerPollIntervalMs: 1, retryJitterRatio: 0 });
    const delivery = await dispatcher.dispatch({ tenantId: 'tenant-a', url: server.url, eventType: 'batch.updated', payload: { ok: true } });
    await dispatcher.tick();
    await new Promise((r) => setTimeout(r, 100));
    await dispatcher.tick(Date.now() + 2_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(server.count()).toBe(2);
    expect(server.headers()['x-idempotency-key']).toBe(delivery.idempotencyKey);
    expect(server.headers()['x-webhook-id']).toBe(delivery.id);
    await server.close();
  });

  it('moves deliveries to the dead-letter queue after max retries', async () => {
    const server = await mockServer([500]);
    const redis = new MemoryRedis();
    const queue = new DeliveryQueue(redis);
    const dlq = new DeadLetterQueue(redis);
    const dispatcher = new WebhookDispatcher(queue, new IdempotencyStore(redis), dlq, { ...DEFAULT_WEBHOOK_CONFIG, maxRetries: 2, requestTimeoutMs: 250, retryJitterRatio: 0 });
    await dispatcher.dispatch({ tenantId: 'tenant-a', url: server.url, eventType: 'escrow.settled', payload: { ok: false } });
    await dispatcher.tick(); await new Promise((r) => setTimeout(r, 100));
    await dispatcher.tick(Date.now() + 2_000); await new Promise((r) => setTimeout(r, 100));
    expect(await queue.depth()).toBe(0);
    expect((await dlq.list()).length).toBe(1);
    await server.close();
  });
});
