import { Gauge } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';

export interface UsageSample {
  service: string;
  resource: 'cpu' | 'memory' | 'connections' | 'queue' | 'storage';
  used: number;
  capacity: number;
  timestamp: Date;
}

export interface CapacityForecast {
  service: string;
  resource: UsageSample['resource'];
  currentUtilization: number;
  projectedUtilization: number;
  growthPerHour: number;
  hoursToThreshold: number | null;
  recommendation: 'hold' | 'watch' | 'scale' | 'urgent';
  recommendedCapacity: number;
}

export interface CapacityPlannerOptions {
  warningThreshold: number;
  criticalThreshold: number;
  targetUtilization: number;
  horizonHours: number;
  minSamples: number;
}

const DEFAULT_OPTIONS: CapacityPlannerOptions = {
  warningThreshold: 0.7,
  criticalThreshold: 0.85,
  targetUtilization: 0.6,
  horizonHours: 24 * 7,
  minSamples: 2,
};

const currentUsageGauge = new Gauge({
  name: 'capacity_planning_current_utilization_ratio',
  help: 'Current resource utilization ratio used for capacity planning',
  labelNames: ['service', 'resource'] as const,
  registers: [metricsRegistry],
});

const projectedUsageGauge = new Gauge({
  name: 'capacity_planning_projected_utilization_ratio',
  help: 'Projected resource utilization ratio at the capacity planning horizon',
  labelNames: ['service', 'resource'] as const,
  registers: [metricsRegistry],
});

const hoursToThresholdGauge = new Gauge({
  name: 'capacity_planning_hours_to_critical_threshold',
  help: 'Forecasted hours until resource utilization reaches the critical threshold; -1 means not trending to threshold',
  labelNames: ['service', 'resource'] as const,
  registers: [metricsRegistry],
});

export class HistoricalUsagePlanner {
  private readonly samples = new Map<string, UsageSample[]>();

  constructor(private readonly options: CapacityPlannerOptions = DEFAULT_OPTIONS) {}

  record(sample: UsageSample): void {
    if (sample.capacity <= 0) throw new Error('capacity must be greater than zero');
    if (sample.used < 0) throw new Error('used must be non-negative');

    const key = sampleKey(sample.service, sample.resource);
    const bucket = this.samples.get(key) ?? [];
    bucket.push({ ...sample, timestamp: new Date(sample.timestamp) });
    bucket.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    this.samples.set(key, bucket.slice(-10_000));
  }

  forecast(service: string, resource: UsageSample['resource']): CapacityForecast {
    const series = this.samples.get(sampleKey(service, resource)) ?? [];
    if (series.length < this.options.minSamples) {
      throw new Error(
        `at least ${this.options.minSamples} samples are required for ${service}/${resource}`,
      );
    }

    const first = series[0];
    const latest = series[series.length - 1];
    const elapsedHours = Math.max(
      1 / 60,
      (latest.timestamp.getTime() - first.timestamp.getTime()) / 3_600_000,
    );
    const firstUtilization = utilization(first);
    const currentUtilization = utilization(latest);
    const growthPerHour = Math.max(0, (currentUtilization - firstUtilization) / elapsedHours);
    const projectedUtilization = clamp01(
      currentUtilization + growthPerHour * this.options.horizonHours,
    );
    const hoursToThreshold =
      growthPerHour > 0 && currentUtilization < this.options.criticalThreshold
        ? (this.options.criticalThreshold - currentUtilization) / growthPerHour
        : currentUtilization >= this.options.criticalThreshold
          ? 0
          : null;
    const recommendedCapacity = Math.ceil(
      Math.max(latest.capacity, latest.used / this.options.targetUtilization),
    );
    const recommendation = this.recommendation(
      currentUtilization,
      projectedUtilization,
      hoursToThreshold,
    );

    currentUsageGauge.set({ service, resource }, currentUtilization);
    projectedUsageGauge.set({ service, resource }, projectedUtilization);
    hoursToThresholdGauge.set({ service, resource }, hoursToThreshold ?? -1);

    return {
      service,
      resource,
      currentUtilization,
      projectedUtilization,
      growthPerHour,
      hoursToThreshold,
      recommendation,
      recommendedCapacity,
    };
  }

  forecastAll(): CapacityForecast[] {
    return Array.from(this.samples.keys()).map((key) => {
      const [service, resource] = key.split('|') as [string, UsageSample['resource']];
      return this.forecast(service, resource);
    });
  }

  private recommendation(
    current: number,
    projected: number,
    hoursToThreshold: number | null,
  ): CapacityForecast['recommendation'] {
    if (
      current >= this.options.criticalThreshold ||
      (hoursToThreshold !== null && hoursToThreshold <= 24)
    )
      return 'urgent';
    if (projected >= this.options.criticalThreshold) return 'scale';
    if (projected >= this.options.warningThreshold) return 'watch';
    return 'hold';
  }
}

function sampleKey(service: string, resource: UsageSample['resource']): string {
  return `${service}|${resource}`;
}

function utilization(sample: UsageSample): number {
  return clamp01(sample.used / sample.capacity);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
