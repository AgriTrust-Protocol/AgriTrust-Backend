import { DependencyGraph, ServiceName } from './dependency_graph';

export type HealthState = 'healthy' | 'degraded' | 'unhealthy';

export interface CascadingFailurePath {
  path: ServiceName[];
  probability: number;
}

export interface CascadingModelOptions {
  baseTransitionProbabilities?: Record<HealthState, Record<HealthState, number>>;
  dependencyImpactFactor?: number;
  predictionWindowMinutes?: number;
  serviceStates?: Partial<Record<ServiceName, HealthState>>;
}

export class CascadingModel {
  private readonly dependencyGraph: DependencyGraph;
  private readonly baseTransitionProbabilities: Record<HealthState, Record<HealthState, number>>;
  private readonly dependencyImpactFactor: number;
  private readonly predictionWindowMinutes: number;
  private readonly serviceStates = new Map<ServiceName, HealthState>();

  constructor(dependencyGraph: DependencyGraph, options: CascadingModelOptions = {}) {
    this.dependencyGraph = dependencyGraph;
    this.baseTransitionProbabilities = {
      healthy: { healthy: 0.85, degraded: 0.13, unhealthy: 0.02 },
      degraded: { healthy: 0.3, degraded: 0.5, unhealthy: 0.2 },
      unhealthy: { healthy: 0.1, degraded: 0.2, unhealthy: 0.7 },
      ...options.baseTransitionProbabilities,
    };
    this.dependencyImpactFactor = options.dependencyImpactFactor ?? 0.3;
    this.predictionWindowMinutes = options.predictionWindowMinutes ?? 5;
    this.setServiceStates(options.serviceStates ?? {});
  }

  setServiceStates(states: Partial<Record<ServiceName, HealthState>>): void {
    this.serviceStates.clear();
    for (const [service, state] of Object.entries(states)) {
      if (state) {
        this.serviceStates.set(service, state);
      }
    }
  }

  setServiceState(service: ServiceName, state: HealthState): void {
    this.serviceStates.set(service, state);
  }

  calculateUnhealthyProbability(service: ServiceName, currentState: HealthState): number {
    const futureMatrix = this.matrixPower(
      this.calculateTransitionProbabilities(service),
      this.predictionWindowMinutes,
    );
    return futureMatrix[currentState].unhealthy;
  }

  findRiskyPaths(
    service: ServiceName,
    currentState: HealthState,
    threshold = 0.15,
  ): CascadingFailurePath[] {
    const riskyPaths: CascadingFailurePath[] = [];
    const visited = new Set<string>();

    const dfs = (currentService: ServiceName, path: ServiceName[], probabilitySoFar: number): void => {
      const pathKey = path.join('->');
      if (visited.has(pathKey)) {
        return;
      }
      visited.add(pathKey);

      const state = currentService === service
        ? currentState
        : this.serviceStates.get(currentService) ?? 'healthy';
      const unhealthyProbability = this.calculateUnhealthyProbability(currentService, state);
      const pathProbability = Math.max(unhealthyProbability, probabilitySoFar * unhealthyProbability);

      if (path.length > 1 && pathProbability > threshold) {
        riskyPaths.push({ path: [...path], probability: pathProbability });
      }

      for (const dependency of this.dependencyGraph.getDependencies(currentService)) {
        if (!path.includes(dependency)) {
          dfs(dependency, [...path, dependency], Math.min(1, probabilitySoFar * unhealthyProbability));
        }
      }
    };

    dfs(service, [service], 1);
    return riskyPaths;
  }

  getHighestRiskPath(
    service: ServiceName,
    currentState: HealthState,
    threshold = 0.15,
  ): CascadingFailurePath | null {
    const paths = this.findRiskyPaths(service, currentState, threshold);
    if (paths.length === 0) {
      return null;
    }
    return paths.reduce((max, current) => current.probability > max.probability ? current : max);
  }

  private calculateTransitionProbabilities(service: ServiceName): Record<HealthState, Record<HealthState, number>> {
    const dependencies = this.dependencyGraph.getDependencies(service);
    const dependencyStateImpact = Array.from(dependencies).reduce((impact, dependency) => {
      const state = this.serviceStates.get(dependency) ?? 'healthy';
      if (state === 'unhealthy') {
        return impact + this.dependencyImpactFactor;
      }
      if (state === 'degraded') {
        return impact + this.dependencyImpactFactor * 0.5;
      }
      return impact;
    }, 0);
    const dependencyImpact = Math.min(dependencies.size * 0.01 + dependencyStateImpact, 0.4);

    const probabilities: Record<HealthState, Record<HealthState, number>> = {
      healthy: { ...this.baseTransitionProbabilities.healthy },
      degraded: { ...this.baseTransitionProbabilities.degraded },
      unhealthy: { ...this.baseTransitionProbabilities.unhealthy },
    };

    probabilities.healthy.degraded = Math.min(0.95, probabilities.healthy.degraded + dependencyImpact);
    probabilities.healthy.unhealthy = Math.min(0.95, probabilities.healthy.unhealthy + dependencyImpact * 0.5);
    probabilities.healthy.healthy = 1 - probabilities.healthy.degraded - probabilities.healthy.unhealthy;

    probabilities.degraded.unhealthy = Math.min(0.95, probabilities.degraded.unhealthy + dependencyImpact);
    probabilities.degraded.degraded = Math.max(0.05, probabilities.degraded.degraded - dependencyImpact * 0.5);
    probabilities.degraded.healthy = 1 - probabilities.degraded.degraded - probabilities.degraded.unhealthy;

    return probabilities;
  }

  private multiplyMatrices(
    a: Record<HealthState, Record<HealthState, number>>,
    b: Record<HealthState, Record<HealthState, number>>,
  ): Record<HealthState, Record<HealthState, number>> {
    const states: HealthState[] = ['healthy', 'degraded', 'unhealthy'];
    const result: Record<HealthState, Record<HealthState, number>> = {
      healthy: { healthy: 0, degraded: 0, unhealthy: 0 },
      degraded: { healthy: 0, degraded: 0, unhealthy: 0 },
      unhealthy: { healthy: 0, degraded: 0, unhealthy: 0 },
    };

    for (const from of states) {
      for (const to of states) {
        result[from][to] = states.reduce(
          (sum, intermediate) => sum + a[from][intermediate] * b[intermediate][to],
          0,
        );
      }
    }

    return result;
  }

  private matrixPower(
    matrix: Record<HealthState, Record<HealthState, number>>,
    power: number,
  ): Record<HealthState, Record<HealthState, number>> {
    let result: Record<HealthState, Record<HealthState, number>> = {
      healthy: { healthy: 1, degraded: 0, unhealthy: 0 },
      degraded: { healthy: 0, degraded: 1, unhealthy: 0 },
      unhealthy: { healthy: 0, degraded: 0, unhealthy: 1 },
    };
    let base = matrix;

    while (power > 0) {
      if (power % 2 === 1) {
        result = this.multiplyMatrices(result, base);
      }
      base = this.multiplyMatrices(base, base);
      power = Math.floor(power / 2);
    }

    return result;
  }
}
