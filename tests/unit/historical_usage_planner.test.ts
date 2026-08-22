import { describe, expect, it, beforeEach } from 'vitest';
import { metricsRegistry } from '../../src/api/metrics/registry';
import { HistoricalUsagePlanner } from '../../src/capacity/historical_usage_planner';

const base = new Date('2026-07-18T00:00:00Z');

describe('HistoricalUsagePlanner', () => {
  beforeEach(() => metricsRegistry.resetMetrics());

  it('forecasts usage growth and recommends scaling before the critical threshold', () => {
    const planner = new HistoricalUsagePlanner({
      warningThreshold: 0.7,
      criticalThreshold: 0.85,
      targetUtilization: 0.6,
      horizonHours: 168,
      minSamples: 2,
    });
    planner.record({ service: 'api', resource: 'cpu', used: 40, capacity: 100, timestamp: base });
    planner.record({
      service: 'api',
      resource: 'cpu',
      used: 72,
      capacity: 100,
      timestamp: new Date(base.getTime() + 14 * 24 * 3_600_000),
    });

    const forecast = planner.forecast('api', 'cpu');

    expect(forecast.currentUtilization).toBe(0.72);
    expect(forecast.projectedUtilization).toBeGreaterThan(0.85);
    expect(forecast.recommendation).toBe('scale');
    expect(forecast.recommendedCapacity).toBe(120);
  });

  it('marks exhausted capacity as urgent', () => {
    const planner = new HistoricalUsagePlanner({
      warningThreshold: 0.7,
      criticalThreshold: 0.85,
      targetUtilization: 0.6,
      horizonHours: 24,
      minSamples: 2,
    });
    planner.record({
      service: 'worker',
      resource: 'queue',
      used: 80,
      capacity: 100,
      timestamp: base,
    });
    planner.record({
      service: 'worker',
      resource: 'queue',
      used: 90,
      capacity: 100,
      timestamp: new Date(base.getTime() + 3_600_000),
    });

    expect(planner.forecast('worker', 'queue').recommendation).toBe('urgent');
  });

  it('exports Prometheus gauges for dashboards and alerts', async () => {
    const planner = new HistoricalUsagePlanner({
      warningThreshold: 0.7,
      criticalThreshold: 0.85,
      targetUtilization: 0.6,
      horizonHours: 24,
      minSamples: 2,
    });
    planner.record({
      service: 'api',
      resource: 'memory',
      used: 50,
      capacity: 100,
      timestamp: base,
    });
    planner.record({
      service: 'api',
      resource: 'memory',
      used: 55,
      capacity: 100,
      timestamp: new Date(base.getTime() + 3_600_000),
    });

    planner.forecast('api', 'memory');
    const metrics = await metricsRegistry.metrics();

    expect(metrics).toContain('capacity_planning_current_utilization_ratio');
    expect(metrics).toContain('capacity_planning_projected_utilization_ratio');
    expect(metrics).toContain('capacity_planning_hours_to_critical_threshold');
  });
});
