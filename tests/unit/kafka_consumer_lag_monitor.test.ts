import { describe, expect, it, beforeEach } from 'vitest';
import { metricsRegistry } from '../../src/api/metrics/registry';
import {
  ConsumerGroupAutoScaler,
  ConsumerLagMonitor,
  type ConsumerGroupLagSummary,
  type ConsumerGroupScalePolicy,
} from '../../src/kafka/consumer_lag_monitor';

const policy: ConsumerGroupScalePolicy = {
  groupId: 'certification-writer',
  service: 'certificate-service',
  minReplicas: 2,
  maxReplicas: 8,
  targetLagPerReplica: 100,
  scaleUpLagThreshold: 250,
  scaleDownLagThreshold: 20,
  cooldownMs: 60_000,
};

beforeEach(() => {
  metricsRegistry.resetMetrics();
});

describe('ConsumerLagMonitor', () => {
  it('summarizes partition lag and publishes Prometheus metrics', async () => {
    const monitor = new ConsumerLagMonitor();

    const summary = monitor.summarize({
      groupId: 'certification-writer',
      service: 'certificate-service',
      observedAt: new Date('2026-07-17T00:00:00Z'),
      partitions: [
        { topic: 'batch.certified', partition: 0, highWatermark: 150, committedOffset: 100 },
        { topic: 'batch.certified', partition: 1, highWatermark: 200, committedOffset: 180 },
        { topic: 'batch.failed', partition: 0, highWatermark: 40, committedOffset: 45 },
      ],
    });

    expect(summary.totalLag).toBe(70);
    expect(summary.maxPartitionLag).toBe(50);
    expect(summary.topicLags).toEqual({ 'batch.certified': 70, 'batch.failed': 0 });

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain(
      'kafka_consumer_group_total_lag{service="certificate-service",group_id="certification-writer"} 70',
    );
    expect(metrics).toContain(
      'kafka_consumer_group_lag{service="certificate-service",group_id="certification-writer",topic="batch.certified",partition="0"} 50',
    );
  });
});

describe('ConsumerGroupAutoScaler', () => {
  const baseSummary: ConsumerGroupLagSummary = {
    groupId: 'certification-writer',
    service: 'certificate-service',
    observedAt: new Date('2026-07-17T00:00:00Z'),
    totalLag: 450,
    maxPartitionLag: 200,
    partitionCount: 6,
    topicLags: { 'batch.certified': 450 },
  };

  it('scales up based on target lag per replica', () => {
    const decision = new ConsumerGroupAutoScaler().evaluate(baseSummary, policy, {
      groupId: policy.groupId,
      service: policy.service,
      currentReplicas: 2,
    });

    expect(decision).toMatchObject({
      action: 'scale_up',
      desiredReplicas: 5,
      reason: 'lag_above_threshold',
    });
  });

  it('scales down gradually when lag is below the low-water mark', () => {
    const decision = new ConsumerGroupAutoScaler().evaluate(
      { ...baseSummary, totalLag: 0 },
      policy,
      { groupId: policy.groupId, service: policy.service, currentReplicas: 4 },
    );

    expect(decision).toMatchObject({
      action: 'scale_down',
      desiredReplicas: 3,
      reason: 'lag_below_threshold',
    });
  });

  it('suppresses scaling while cooldown is active', () => {
    const decision = new ConsumerGroupAutoScaler().evaluate(
      baseSummary,
      policy,
      {
        groupId: policy.groupId,
        service: policy.service,
        currentReplicas: 2,
        lastScaleAt: new Date('2026-07-17T00:00:30Z'),
      },
      new Date('2026-07-17T00:01:00Z'),
    );

    expect(decision).toMatchObject({
      action: 'none',
      desiredReplicas: 2,
      reason: 'cooldown_active',
    });
  });

  it('applies actionable decisions through the injected scaler', async () => {
    const applied: string[] = [];
    const scaler = new ConsumerGroupAutoScaler({
      async scale(decision) {
        applied.push(`${decision.service}:${decision.desiredReplicas}`);
      },
    });

    await scaler.apply({
      groupId: policy.groupId,
      service: policy.service,
      desiredReplicas: 6,
      action: 'scale_up',
      reason: 'lag_above_threshold',
      totalLag: 600,
    });

    expect(applied).toEqual(['certificate-service:6']);
  });
});
