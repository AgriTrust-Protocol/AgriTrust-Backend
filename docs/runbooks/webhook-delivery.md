# Webhook Delivery Runbook

## Symptoms

- Rising `webhook_queue_depth`.
- Increased `webhook_delivery_attempts_total{result="retry"}`.
- Dead letters appearing in `/webhooks/dead-letter`.

## Triage

1. Check subscriber status pages and recent deploys.
2. Inspect failed delivery errors in the admin dead-letter endpoint.
3. Verify signing secrets match receiver configuration.
4. Confirm Redis latency and worker concurrency are healthy.

## Recovery

- For subscriber outages, wait for automatic retries when the next retry time is inside the 24-hour window.
- For bad secrets or fixed receiver bugs, replay dead letters with `POST /webhooks/dead-letter/:id/replay`.
- For queue pressure, temporarily increase worker replicas and tenant concurrency after checking downstream capacity.
