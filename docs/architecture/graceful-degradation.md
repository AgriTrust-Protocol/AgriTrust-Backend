# Graceful Degradation Architecture

AgriTrust uses a two-layer resilience model to preserve critical API paths under partial dependency failure or platform saturation.

## Layers

1. **Feature flags** (`src/resilience/feature-flags.ts`) provide deterministic enable, disable, and shadow states. Flags can be controlled through process environment variables using `FEATURE_<FLAG_NAME>` where punctuation is converted to underscores, for example `FEATURE_WEBHOOK_DELIVERY=disabled`.
2. **Capacity shedding** (`src/resilience/capacity-shedder.ts`) computes a pressure score from in-flight requests, event-loop lag, CPU utilization, and memory utilization. Critical routes remain available, background routes shed first, and important routes shed only at a higher saturation threshold.

## Request priority

| Priority | Examples | Behavior under pressure |
| --- | --- | --- |
| Critical | `/health`, `/metrics` | Always served; response may include `X-Degraded-Mode`. |
| Important | Regular read/write API traffic | Served until high saturation, then returns `503 capacity_shed`. |
| Background | Webhook replay and admin job traffic | Shed at moderate saturation with `Retry-After`. |

## SLO guardrails

- Critical path target: keep resilience decisions in-process and O(1), comfortably below the 100ms P99 target.
- Availability target: prioritize health, metrics, and user-facing API traffic before asynchronous fan-out.
- Security review: feature names are validated and unknown flags fail closed by throwing during evaluation.

## Deployment strategy

1. Blue environment receives the code with all default flags enabled.
2. Canary enables capacity-shedding metrics and verifies no unexpected `resilience_shed_requests_total` growth.
3. Gradually lower thresholds in the canary only if load tests confirm critical path latency remains below target.
4. Promote green when dashboards show stable capacity score and no critical errors.
