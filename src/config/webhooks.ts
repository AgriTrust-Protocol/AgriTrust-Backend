export const WEBHOOK_RETRY_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000,
] as const;

export interface WebhookConfig {
  requestTimeoutMs: number;
  maxRetries: number;
  maxAttemptWindowMs: number;
  idempotencyTtlSeconds: number;
  tenantConcurrency: number;
  maxPendingDeliveries: number;
  workerPollIntervalMs: number;
  retryJitterRatio: number;
}

export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = {
  requestTimeoutMs: 10_000,
  maxRetries: 10,
  maxAttemptWindowMs: 24 * 60 * 60 * 1_000,
  idempotencyTtlSeconds: 24 * 60 * 60,
  tenantConcurrency: 50,
  maxPendingDeliveries: 100_000,
  workerPollIntervalMs: 100,
  retryJitterRatio: 0.2,
};

export function retryDelayMs(attempt: number, jitterRatio = DEFAULT_WEBHOOK_CONFIG.retryJitterRatio): number {
  const base = WEBHOOK_RETRY_DELAYS_MS[Math.max(0, Math.min(attempt - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1))];
  const jitter = base * jitterRatio;
  return Math.max(0, Math.round(base - jitter + Math.random() * jitter * 2));
}
