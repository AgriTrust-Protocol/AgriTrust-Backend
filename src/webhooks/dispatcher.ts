import { randomUUID } from 'crypto';
import { DEFAULT_WEBHOOK_CONFIG, retryDelayMs, WebhookConfig } from '../config/webhooks';
import { DeadLetterQueue } from './dead-letter-queue';
import { DeliveryQueue } from './delivery-queue';
import { IdempotencyStore } from './idempotency-store';
import { WebhookDelivery } from './types';

export class WebhookDispatcher {
  private activeByTenant = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly queue: DeliveryQueue,
    private readonly idempotency: IdempotencyStore,
    private readonly deadLetters: DeadLetterQueue,
    private readonly config: WebhookConfig = DEFAULT_WEBHOOK_CONFIG,
  ) {}

  async dispatch(input: Omit<WebhookDelivery, 'id' | 'idempotencyKey' | 'attempt' | 'createdAt' | 'nextRetryAt' | 'errors'> & Partial<Pick<WebhookDelivery, 'id' | 'idempotencyKey'>>): Promise<WebhookDelivery> {
    const now = Date.now();
    const delivery: WebhookDelivery = { id: input.id ?? randomUUID(), tenantId: input.tenantId, subscriptionId: input.subscriptionId, url: input.url, eventType: input.eventType, payload: input.payload, idempotencyKey: input.idempotencyKey ?? randomUUID(), attempt: 0, createdAt: now, nextRetryAt: now, errors: [] };
    await this.queue.enqueue(delivery);
    return delivery;
  }

  start(): void { if (!this.timer) this.timer = setInterval(() => void this.tick(), this.config.workerPollIntervalMs); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async tick(now = Date.now()): Promise<void> {
    const due = await this.queue.popDue(now, 100);
    for (const delivery of due) {
      if ((this.activeByTenant.get(delivery.tenantId) ?? 0) >= this.config.tenantConcurrency) { await this.queue.enqueue({ ...delivery, nextRetryAt: now + this.config.workerPollIntervalMs }); continue; }
      this.activeByTenant.set(delivery.tenantId, (this.activeByTenant.get(delivery.tenantId) ?? 0) + 1);
      void this.attempt(delivery).finally(() => this.activeByTenant.set(delivery.tenantId, Math.max(0, (this.activeByTenant.get(delivery.tenantId) ?? 1) - 1)));
    }
  }

  private async attempt(delivery: WebhookDelivery): Promise<void> {
    const current = { ...delivery, attempt: delivery.attempt + 1 };
    if (delivery.attempt === 0 && !(await this.idempotency.markIfNew(current.idempotencyKey))) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      const response = await fetch(current.url, { method: 'POST', body: JSON.stringify(current.payload), headers: { 'content-type': 'application/json', 'x-idempotency-key': current.idempotencyKey, 'x-webhook-id': current.id, 'x-event-type': current.eventType }, signal: controller.signal });
      clearTimeout(timer);
      if (response.status >= 200 && response.status < 300) { await this.queue.remove(current.id); return; }
      if (response.status === 429 || response.status >= 500) throw Object.assign(new Error(`Retryable webhook status ${response.status}`), { status: response.status });
      await this.deadLetters.add({ ...current, errors: [...current.errors, { at: Date.now(), attempt: current.attempt, status: response.status, message: `Non-retryable webhook status ${response.status}` }] }, 'non_retryable_status');
    } catch (err) {
      const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : undefined;
      const failed = { ...current, errors: [...current.errors, { at: Date.now(), attempt: current.attempt, status, message: err instanceof Error ? err.message : String(err) }] };
      if (failed.attempt >= this.config.maxRetries || Date.now() - failed.createdAt >= this.config.maxAttemptWindowMs) { await this.deadLetters.add(failed, 'max_retries_exhausted'); return; }
      await this.queue.enqueue({ ...failed, nextRetryAt: Date.now() + retryDelayMs(failed.attempt, this.config.retryJitterRatio) });
    }
  }
}
