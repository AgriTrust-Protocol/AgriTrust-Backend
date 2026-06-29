export interface WebhookDelivery {
  id: string;
  tenantId: string;
  subscriptionId?: string;
  url: string;
  eventType: string;
  payload: unknown;
  idempotencyKey: string;
  attempt: number;
  createdAt: number;
  nextRetryAt: number;
  errors: WebhookDeliveryError[];
}

export interface WebhookDeliveryError {
  at: number;
  attempt: number;
  message: string;
  status?: number;
}

export interface DeadLetterWebhook extends WebhookDelivery {
  deadLetteredAt: number;
  reason: string;
}

export interface WebhookSubscription {
  id: string;
  tenantId: string;
  url: string;
  eventTypes: string[];
  createdAt: number;
}
