import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { DeliveryQueue } from '../../webhooks/delivery-queue';
import { DeadLetterQueue } from '../../webhooks/dead-letter-queue';
import { SubscriptionManager } from '../../webhooks/subscription-manager';
import { WebhookDispatcher } from '../../webhooks/dispatcher';

export function createAdminWebhooksRouter(queue: DeliveryQueue, deadLetters: DeadLetterQueue, subscriptions: SubscriptionManager, dispatcher: WebhookDispatcher): Router {
  const router = Router();
  router.get('/webhooks/deliveries', async (_req: Request, res: Response) => res.status(200).json({ deliveries: await queue.list(100), depth: await queue.depth() }));
  router.get('/webhooks/dead-letter', async (_req: Request, res: Response) => res.status(200).json({ deadLetters: await deadLetters.list(100) }));
  router.post('/webhooks/dead-letter/:id/replay', async (req: Request, res: Response) => {
    const dead = await deadLetters.remove(String(req.params.id));
    if (!dead) { res.status(404).json({ error: 'Dead-letter delivery not found' }); return; }
    const replay = await dispatcher.dispatch({ id: randomUUID(), tenantId: dead.tenantId, subscriptionId: dead.subscriptionId, url: dead.url, eventType: dead.eventType, payload: dead.payload, idempotencyKey: randomUUID() });
    res.status(202).json({ replay });
  });
  router.post('/webhooks/subscriptions', async (req: Request, res: Response) => {
    const { tenantId, url, eventTypes } = req.body ?? {};
    if (typeof tenantId !== 'string' || typeof url !== 'string') { res.status(400).json({ error: 'tenantId and url are required' }); return; }
    res.status(201).json({ subscription: await subscriptions.register({ tenantId, url, eventTypes }) });
  });
  return router;
}
