# Webhook Delivery Service

## Architecture

Webhook delivery is an asynchronous, system-wide worker path. Services enqueue a `WebhookDelivery` with tenant, subscription, event type, payload, idempotency key, and optional signing secret. `DeliveryQueue` stores due work in Redis sorted sets, `WebhookDispatcher` POSTs JSON to subscribers, and `DeadLetterQueue` keeps exhausted or non-retryable deliveries for operator replay.

Critical request paths only enqueue work and return; remote HTTP delivery runs out of band to keep P99 latency under 100 ms.

## Retry policy

Retryable failures are HTTP 429, HTTP 5xx, timeouts, and network errors. Delays use exponential backoff from 1s to 512s with configurable jitter. Deliveries stop when `maxRetries` or the 24-hour attempt window is reached, then move to the dead-letter queue.

## Signature verification

Every signed delivery includes:

- `x-agritrust-timestamp`: Unix seconds used for replay protection.
- `x-agritrust-signature`: `v1=<hex hmac sha256>` over `<timestamp>.<raw JSON body>`.

Receivers should reject timestamps outside five minutes and compare HMACs with constant-time comparison. The helper `verifyWebhookSignature` implements this verification contract.

## Monitoring and alerts

Prometheus metrics:

- `webhook_delivery_attempts_total{tenant_id,event_type,result}` for success, retry, and dead-letter outcomes.
- `webhook_queue_depth` for queued deliveries.

Suggested alerts:

- Page when dead-letter attempts are non-zero for 10 minutes.
- Warn when queue depth grows for 15 minutes or exceeds tenant capacity.
- Page when webhook success rate drops below 99.9% over 15 minutes.

## Deployment

Use blue-green deployment for dispatcher changes. Enable the new worker pool in green with 5% canary traffic, compare queue depth, retry rate, dead-letter rate, and P99 enqueue latency for 30 minutes, then shift 25%, 50%, and 100% if metrics stay within SLO.
