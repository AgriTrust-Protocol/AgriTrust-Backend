# Kafka Consumer Lag Monitoring and Auto-Scaling Runbook

## Architecture

AgriTrust services report Kafka partition high-water marks and committed offsets to `ConsumerLagMonitor`. The monitor publishes per-partition and total consumer-group lag to the unified Prometheus registry used by `/metrics`. `ConsumerGroupAutoScaler` converts lag summaries into deterministic scale decisions for a deployment adapter such as Kubernetes HPA, KEDA, or an internal orchestrator.

The design keeps the critical request path under the 100 ms P99 target by making lag collection asynchronous and O(partition count), while the scaler emits only a decision object until an injected adapter applies the change.

## Metrics

- `kafka_consumer_group_lag{service,group_id,topic,partition}`: per-partition lag.
- `kafka_consumer_group_total_lag{service,group_id}`: total lag for scaling and alerting.
- `kafka_consumer_group_scaling_decisions_total{service,group_id,action}`: scale-up, scale-down, and no-op decisions.
- `kafka_consumer_group_scaling_evaluation_duration_seconds`: decision latency to enforce the <100 ms P99 target.

## Auto-scaling policy

Each consumer group should define:

- `minReplicas` and `maxReplicas` guardrails.
- `targetLagPerReplica` for proportional scale-up.
- `scaleUpLagThreshold` high-water mark.
- `scaleDownLagThreshold` low-water mark.
- `cooldownMs` to prevent oscillation during rebalances.

Scale-up chooses the larger of `currentReplicas + 1` and `ceil(totalLag / targetLagPerReplica)`, clamped to policy bounds. Scale-down removes one replica at a time only when lag is below the low-water mark.

## Alerts and dashboards

Load `monitoring/prometheus/kafka-consumer-lag-alerts.yaml` into Prometheus and import `monitoring/grafana/dashboards/kafka-consumer-lag.json` into Grafana. Page on critical lag sustained for five minutes; warn when lag grows for fifteen minutes.

## Deployment

1. Deploy the monitor and scaler with blue-green strategy.
2. Enable metrics scraping in the green stack first.
3. Run a canary for one low-risk consumer group with scale actions logged but not applied.
4. Compare lag reduction, scaler P99 latency, error rate, and rebalance count between blue and green.
5. Enable adapter apply mode after canary metrics are stable for at least 30 minutes.
6. Roll back by disabling the adapter; metrics collection can remain enabled because it is read-only.

## Security review checklist

- Do not log message payloads, keys, credentials, or SASL configuration.
- Limit scaler credentials to patching the specific deployment or scaling resource.
- Require change approval for policy changes that increase `maxReplicas`.
- Validate dashboard and alert labels do not expose tenant secrets.
