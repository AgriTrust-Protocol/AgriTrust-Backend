import { createHmac, timingSafeEqual } from 'crypto';

export const WEBHOOK_SIGNATURE_HEADER = 'x-agritrust-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-agritrust-timestamp';
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

export interface WebhookSignatureParts {
  timestamp: number;
  signature: string;
}

export function canonicalWebhookPayload(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

export function signWebhookPayload(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const digest = createHmac('sha256', secret)
    .update(canonicalWebhookPayload(timestamp, body))
    .digest('hex');
  return `${WEBHOOK_SIGNATURE_VERSION}=${digest}`;
}

export function parseWebhookSignature(header: string): string | null {
  const parts = header.split(',').map((part) => part.trim());
  const versioned = parts.find((part) => part.startsWith(`${WEBHOOK_SIGNATURE_VERSION}=`));
  return versioned?.slice(`${WEBHOOK_SIGNATURE_VERSION}=`.length) ?? null;
}

export function verifyWebhookSignature(input: {
  secret: string;
  body: string;
  timestamp: number;
  signatureHeader: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(input.timestamp) ||
    Math.abs(nowSeconds - input.timestamp) > toleranceSeconds
  )
    return false;
  const provided = parseWebhookSignature(input.signatureHeader);
  if (!provided) return false;
  const expected = signWebhookPayload(input.secret, input.body, input.timestamp).slice(
    `${WEBHOOK_SIGNATURE_VERSION}=`.length,
  );
  const providedBuffer = Buffer.from(provided, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}
