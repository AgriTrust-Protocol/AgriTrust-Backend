import { describe, expect, it, beforeEach } from 'vitest';
import { metricsRegistry } from '../../src/api/metrics/registry';
import { HealthAggregator } from '../../src/health/aggregator';
import { HealthChecker, HealthCheckProbe } from '../../src/health/checker';
import { InMemoryDependencyGraph, parseDependencyYaml } from '../../src/health/dependency_graph';

describe('health aggregation and cascading failure prediction', () => {
  beforeEach(() => {
    metricsRegistry.resetMetrics();
  });

  it('parses dependency YAML and normalizes empty leaf declarations', () => {
    const parsed = parseDependencyYaml(`
api-gateway:
  - inventory-service
database:
  - []
`);
    const graph = new InMemoryDependencyGraph(parsed);

    expect(graph.getDependencies('api-gateway')).toEqual(new Set(['inventory-service']));
    expect(graph.getDependencies('database').size).toBe(0);
    expect(graph.getAllServices().has('')).toBe(false);
  });

  it('calculates the weighted aggregate score from latest health checks', async () => {
    const probe: HealthCheckProbe = async (_service, type) => {
      if (type === 'readiness') {
        return { status: 'degraded' };
      }
      if (type === 'depth') {
        return { status: 'unhealthy' };
      }
      return { status: 'healthy' };
    };
    const graph = new InMemoryDependencyGraph({ 'api-gateway': [] });
    const aggregator = new HealthAggregator(
      graph,
      new HealthChecker(probe, { liveness: 50, readiness: 50, depth: 50 }),
    );

    const snapshot = await aggregator.evaluateService('api-gateway');

    expect(snapshot.aggregatedScore).toBe(0.5);
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.checks).toHaveLength(3);
  });

  it('emits a warning with path trace when downstream degradation exceeds threshold', async () => {
    const graph = new InMemoryDependencyGraph({
      'api-gateway': ['inventory-service'],
      'inventory-service': ['database'],
      database: [],
    });
    const probe: HealthCheckProbe = async (service) => {
      if (service === 'inventory-service') {
        return { status: 'unhealthy', error: 'simulated dependency outage' };
      }
      return { status: 'healthy' };
    };
    const aggregator = new HealthAggregator(
      graph,
      new HealthChecker(probe, { liveness: 50, readiness: 50, depth: 50 }),
      undefined,
      { cascadingFailureThreshold: 0.15 },
    );

    await aggregator.evaluateService('inventory-service');
    const snapshot = await aggregator.evaluateService('api-gateway');

    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0].level).toBe('WARNING');
    expect(snapshot.alerts[0].message).toContain('api-gateway -> inventory-service');
    expect(snapshot.alerts[0].details.probability).toBeGreaterThan(0.15);
  });

  it('exports health check, aggregate score, and cascading probability metrics', async () => {
    const graph = new InMemoryDependencyGraph({ 'api-gateway': ['database'], database: [] });
    const aggregator = new HealthAggregator(
      graph,
      new HealthChecker(async () => ({ status: 'healthy' }), {
        liveness: 50,
        readiness: 50,
        depth: 50,
      }),
    );

    await aggregator.evaluateService('api-gateway');
    const metrics = await metricsRegistry.metrics();

    expect(metrics).toContain('health_check_status');
    expect(metrics).toContain('health_aggregated_score');
    expect(metrics).toContain('cascading_failure_probability');
  });
});
