import { Counter, Gauge } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';

export const webhookDeliveryAttemptsTotal = new Counter({
  name: 'webhook_delivery_attempts_total',
  help: 'Webhook delivery attempts by tenant, event type, and result.',
  labelNames: ['tenant_id', 'event_type', 'result'] as const,
  registers: [metricsRegistry],
});

export const webhookQueueDepth = new Gauge({
  name: 'webhook_queue_depth',
  help: 'Number of webhook deliveries waiting for retry or first delivery.',
  registers: [metricsRegistry],
});

export function recordWebhookAttempt(
  tenantId: string,
  eventType: string,
  result: 'success' | 'retry' | 'dead_letter',
): void {
  webhookDeliveryAttemptsTotal.inc({ tenant_id: tenantId, event_type: eventType, result });
}

export function setWebhookQueueDepth(depth: number): void {
  webhookQueueDepth.set(depth);
}
