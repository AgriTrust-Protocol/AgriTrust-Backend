import { Router } from 'express';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { HealthAggregator } from './aggregator';
import { InMemoryDependencyGraph } from './dependency_graph';

export function createHealthRouter(aggregator = createDefaultHealthAggregator()): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const services = await aggregator.evaluateAll();
      res.status(200).json({
        timestamp: Date.now(),
        services,
        summary: summarizeServices(services),
      });
    } catch (err: unknown) {
      res.status(500).json({
        error: 'Health aggregation failed',
        message: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    }
  });

  return router;
}

export function createDefaultHealthAggregator(): HealthAggregator {
  const dependencyPath = resolve(process.cwd(), 'config', 'dependencies.yaml');
  const graph = existsSync(dependencyPath)
    ? InMemoryDependencyGraph.fromYamlFile(dependencyPath)
    : new InMemoryDependencyGraph();
  return new HealthAggregator(graph);
}

function summarizeServices(services: Record<string, { status: string; cascadingPaths: unknown[] }>) {
  const entries = Object.values(services);
  return {
    totalServices: entries.length,
    healthy: entries.filter(service => service.status === 'healthy').length,
    degraded: entries.filter(service => service.status === 'degraded').length,
    unhealthy: entries.filter(service => service.status === 'unhealthy').length,
    servicesWithCascadingRisk: entries.filter(service => service.cascadingPaths.length > 0).length,
  };
}
