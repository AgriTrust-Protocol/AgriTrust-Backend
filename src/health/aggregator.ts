import { Gauge } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';
import { CascadingFailurePath, CascadingModel, HealthState } from './cascading_model';
import { HealthChecker, HealthCheckResult, HealthStatus } from './checker';
import { DependencyGraph, ServiceName } from './dependency_graph';

export interface HealthAlert {
  id: string;
  service: ServiceName;
  level: 'WARNING' | 'CRITICAL';
  message: string;
  timestamp: number;
  details: {
    path: ServiceName[];
    probability: number;
    currentState: HealthState;
    checkResults: HealthCheckResult[];
  };
}

export interface ServiceHealthSnapshot {
  status: HealthState;
  aggregatedScore: number;
  cascadingFailureProbability: number;
  cascadingPaths: Array<{ path: ServiceName[]; trace: string; probability: number }>;
  checks: HealthCheckResult[];
  alerts: HealthAlert[];
}

export interface HealthAggregatorOptions {
  aggregationWindowSeconds: number;
  cascadingFailureThreshold: number;
}

const DEFAULT_OPTIONS: HealthAggregatorOptions = {
  aggregationWindowSeconds: 300,
  cascadingFailureThreshold: 0.15,
};

const statusToValue: Record<HealthStatus, number> = {
  healthy: 1,
  degraded: 0.5,
  unhealthy: 0,
};

export const healthCheckStatus = new Gauge({
  name: 'health_check_status',
  help: 'Health check status by service and type (1=healthy, 0.5=degraded, 0=unhealthy)',
  labelNames: ['service', 'type'],
  registers: [metricsRegistry],
});

export const healthAggregatedScore = new Gauge({
  name: 'health_aggregated_score',
  help: 'Weighted aggregate health score by service',
  labelNames: ['service'],
  registers: [metricsRegistry],
});

export const cascadingFailureProbability = new Gauge({
  name: 'cascading_failure_probability',
  help: 'Probability of cascading failure by service and downstream path',
  labelNames: ['service', 'path'],
  registers: [metricsRegistry],
});

export class HealthAggregator {
  private readonly checker: HealthChecker;
  private readonly dependencyGraph: DependencyGraph;
  private readonly cascadingModel: CascadingModel;
  private readonly options: HealthAggregatorOptions;
  private readonly checkResults = new Map<ServiceName, HealthCheckResult[]>();
  private readonly recentAlerts = new Map<string, number>();

  constructor(
    dependencyGraph: DependencyGraph,
    checker = new HealthChecker(),
    cascadingModel = new CascadingModel(dependencyGraph),
    options: Partial<HealthAggregatorOptions> = {},
  ) {
    this.dependencyGraph = dependencyGraph;
    this.checker = checker;
    this.cascadingModel = cascadingModel;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getServicesToMonitor(): Set<ServiceName> {
    return this.dependencyGraph.getAllServices();
  }

  async evaluateService(service: ServiceName): Promise<ServiceHealthSnapshot> {
    const results = await this.checker.checkAll(service);
    this.storeCheckResults(service, results);
    this.cleanupOldResults(service);

    const aggregatedScore = this.calculateAggregatedScore(service);
    const status = this.determineOverallState(aggregatedScore);
    this.cascadingModel.setServiceState(service, status);

    const cascadingFailureProbabilityValue = this.cascadingModel.calculateUnhealthyProbability(service, status);
    const riskyPaths = this.cascadingModel.findRiskyPaths(
      service,
      status,
      this.options.cascadingFailureThreshold,
    );
    const alerts = this.createAlerts(service, status, results, riskyPaths);
    const checks = this.getLatestCheckResults(service);

    this.updateMetrics(service, checks, aggregatedScore, cascadingFailureProbabilityValue, riskyPaths);

    return {
      status,
      aggregatedScore: round(aggregatedScore),
      cascadingFailureProbability: round(cascadingFailureProbabilityValue),
      cascadingPaths: riskyPaths.map(path => ({
        path: path.path,
        trace: path.path.join(' -> '),
        probability: round(path.probability),
      })),
      checks,
      alerts,
    };
  }

  async evaluateAll(): Promise<Record<ServiceName, ServiceHealthSnapshot>> {
    const statuses: Record<ServiceName, ServiceHealthSnapshot> = {};
    for (const service of this.getServicesToMonitor()) {
      statuses[service] = await this.evaluateService(service);
    }
    return statuses;
  }

  calculateAggregatedScore(service: ServiceName): number {
    const latestByType = new Map<string, HealthCheckResult>();
    for (const result of this.checkResults.get(service) ?? []) {
      const existing = latestByType.get(result.type);
      if (!existing || result.timestamp > existing.timestamp) {
        latestByType.set(result.type, result);
      }
    }

    const liveness = statusToValue[latestByType.get('liveness')?.status ?? 'unhealthy'];
    const readiness = statusToValue[latestByType.get('readiness')?.status ?? 'unhealthy'];
    const depth = statusToValue[latestByType.get('depth')?.status ?? 'unhealthy'];
    return Math.max(0, Math.min(1, 0.3 * liveness + 0.4 * readiness + 0.3 * depth));
  }

  determineOverallState(score: number): HealthState {
    if (score >= 0.8) {
      return 'healthy';
    }
    if (score >= 0.4) {
      return 'degraded';
    }
    return 'unhealthy';
  }

  getLatestCheckResults(service: ServiceName): HealthCheckResult[] {
    const latestByType = new Map<string, HealthCheckResult>();
    for (const result of this.checkResults.get(service) ?? []) {
      const existing = latestByType.get(result.type);
      if (!existing || result.timestamp > existing.timestamp) {
        latestByType.set(result.type, result);
      }
    }
    return Array.from(latestByType.values());
  }

  private storeCheckResults(service: ServiceName, results: HealthCheckResult[]): void {
    const stored = this.checkResults.get(service) ?? [];
    stored.push(...results);
    this.checkResults.set(service, stored);
  }

  private cleanupOldResults(service: ServiceName): void {
    const cutoff = Date.now() - this.options.aggregationWindowSeconds * 1000;
    this.checkResults.set(
      service,
      (this.checkResults.get(service) ?? []).filter(result => result.timestamp >= cutoff),
    );
  }

  private createAlerts(
    service: ServiceName,
    currentState: HealthState,
    checkResults: HealthCheckResult[],
    riskyPaths: CascadingFailurePath[],
  ): HealthAlert[] {
    if (currentState === 'unhealthy') {
      return [];
    }

    const alerts: HealthAlert[] = [];
    const now = Date.now();
    for (const riskyPath of riskyPaths) {
      const id = `cascading-${service}-${riskyPath.path.join('-')}`;
      const lastAlertAt = this.recentAlerts.get(id);
      if (lastAlertAt && now - lastAlertAt < 5 * 60 * 1000) {
        continue;
      }
      this.recentAlerts.set(id, now);
      alerts.push({
        id,
        service,
        level: 'WARNING',
        message: `Cascading failure risk detected: ${riskyPath.path.join(' -> ')} (P=${riskyPath.probability.toFixed(2)})`,
        timestamp: now,
        details: {
          path: riskyPath.path,
          probability: round(riskyPath.probability),
          currentState,
          checkResults,
        },
      });
    }
    return alerts;
  }

  private updateMetrics(
    service: ServiceName,
    checks: HealthCheckResult[],
    aggregatedScore: number,
    unhealthyProbability: number,
    riskyPaths: CascadingFailurePath[],
  ): void {
    for (const check of checks) {
      healthCheckStatus.set({ service, type: check.type }, statusToValue[check.status]);
    }
    healthAggregatedScore.set({ service }, aggregatedScore);
    cascadingFailureProbability.set({ service, path: 'overall' }, unhealthyProbability);
    for (const riskyPath of riskyPaths) {
      cascadingFailureProbability.set({ service, path: riskyPath.path.join('->') }, riskyPath.probability);
    }
  }
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
