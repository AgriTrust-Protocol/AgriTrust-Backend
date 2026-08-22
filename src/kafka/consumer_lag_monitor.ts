import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';

export interface KafkaPartitionOffset {
  topic: string;
  partition: number;
  highWatermark: number;
  committedOffset: number;
}

export interface ConsumerGroupLagSnapshot {
  groupId: string;
  service: string;
  observedAt: Date;
  partitions: KafkaPartitionOffset[];
}

export interface ConsumerGroupLagSummary {
  groupId: string;
  service: string;
  observedAt: Date;
  totalLag: number;
  maxPartitionLag: number;
  partitionCount: number;
  topicLags: Record<string, number>;
}

export interface ConsumerGroupScalePolicy {
  groupId: string;
  service: string;
  minReplicas: number;
  maxReplicas: number;
  targetLagPerReplica: number;
  scaleUpLagThreshold: number;
  scaleDownLagThreshold: number;
  cooldownMs: number;
}

export interface ConsumerGroupScaleState {
  groupId: string;
  service: string;
  currentReplicas: number;
  lastScaleAt?: Date;
}

export interface ScaleDecision {
  groupId: string;
  service: string;
  desiredReplicas: number;
  action: 'scale_up' | 'scale_down' | 'none';
  reason: string;
  totalLag: number;
}

export interface ConsumerGroupScaler {
  scale(decision: ScaleDecision): Promise<void>;
}

const lagGauge = new Gauge({
  name: 'kafka_consumer_group_lag',
  help: 'Kafka consumer group lag by service, group, topic, and partition',
  labelNames: ['service', 'group_id', 'topic', 'partition'] as const,
  registers: [metricsRegistry],
});

const totalLagGauge = new Gauge({
  name: 'kafka_consumer_group_total_lag',
  help: 'Total Kafka consumer group lag by service and group',
  labelNames: ['service', 'group_id'] as const,
  registers: [metricsRegistry],
});

const scalingDecisionCounter = new Counter({
  name: 'kafka_consumer_group_scaling_decisions_total',
  help: 'Kafka consumer group auto-scaling decisions by service, group, and action',
  labelNames: ['service', 'group_id', 'action'] as const,
  registers: [metricsRegistry],
});

const scalingEvaluationHistogram = new Histogram({
  name: 'kafka_consumer_group_scaling_evaluation_duration_seconds',
  help: 'Time spent evaluating Kafka consumer group lag scaling decisions',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [metricsRegistry],
});

export class ConsumerLagMonitor {
  summarize(snapshot: ConsumerGroupLagSnapshot): ConsumerGroupLagSummary {
    const topicLags: Record<string, number> = {};
    let totalLag = 0;
    let maxPartitionLag = 0;

    for (const partition of snapshot.partitions) {
      const lag = Math.max(0, partition.highWatermark - partition.committedOffset);
      totalLag += lag;
      maxPartitionLag = Math.max(maxPartitionLag, lag);
      topicLags[partition.topic] = (topicLags[partition.topic] ?? 0) + lag;

      lagGauge.set(
        {
          service: snapshot.service,
          group_id: snapshot.groupId,
          topic: partition.topic,
          partition: String(partition.partition),
        },
        lag,
      );
    }

    totalLagGauge.set({ service: snapshot.service, group_id: snapshot.groupId }, totalLag);

    return {
      groupId: snapshot.groupId,
      service: snapshot.service,
      observedAt: snapshot.observedAt,
      totalLag,
      maxPartitionLag,
      partitionCount: snapshot.partitions.length,
      topicLags,
    };
  }
}

export class ConsumerGroupAutoScaler {
  constructor(private readonly scaler?: ConsumerGroupScaler) {}

  evaluate(
    summary: ConsumerGroupLagSummary,
    policy: ConsumerGroupScalePolicy,
    state: ConsumerGroupScaleState,
    now: Date = new Date(),
  ): ScaleDecision {
    const endTimer = scalingEvaluationHistogram.startTimer();
    try {
      if (state.lastScaleAt && now.getTime() - state.lastScaleAt.getTime() < policy.cooldownMs) {
        return this.record({
          groupId: summary.groupId,
          service: summary.service,
          desiredReplicas: state.currentReplicas,
          action: 'none',
          reason: 'cooldown_active',
          totalLag: summary.totalLag,
        });
      }

      if (summary.totalLag >= policy.scaleUpLagThreshold) {
        const lagBasedReplicas = Math.ceil(summary.totalLag / policy.targetLagPerReplica);
        const desiredReplicas = clamp(
          Math.max(state.currentReplicas + 1, lagBasedReplicas),
          policy.minReplicas,
          policy.maxReplicas,
        );
        return this.record({
          groupId: summary.groupId,
          service: summary.service,
          desiredReplicas,
          action: desiredReplicas > state.currentReplicas ? 'scale_up' : 'none',
          reason:
            desiredReplicas > state.currentReplicas
              ? 'lag_above_threshold'
              : 'max_replicas_reached',
          totalLag: summary.totalLag,
        });
      }

      if (
        summary.totalLag <= policy.scaleDownLagThreshold &&
        state.currentReplicas > policy.minReplicas
      ) {
        return this.record({
          groupId: summary.groupId,
          service: summary.service,
          desiredReplicas: state.currentReplicas - 1,
          action: 'scale_down',
          reason: 'lag_below_threshold',
          totalLag: summary.totalLag,
        });
      }

      return this.record({
        groupId: summary.groupId,
        service: summary.service,
        desiredReplicas: state.currentReplicas,
        action: 'none',
        reason: 'within_thresholds',
        totalLag: summary.totalLag,
      });
    } finally {
      endTimer();
    }
  }

  async apply(decision: ScaleDecision): Promise<void> {
    if (decision.action === 'none' || !this.scaler) return;
    await this.scaler.scale(decision);
  }

  private record(decision: ScaleDecision): ScaleDecision {
    scalingDecisionCounter.inc({
      service: decision.service,
      group_id: decision.groupId,
      action: decision.action,
    });
    return decision;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const kafkaConsumerLagMetrics = {
  lagGauge,
  totalLagGauge,
  scalingDecisionCounter,
  scalingEvaluationHistogram,
};
