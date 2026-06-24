import { readFileSync } from 'fs';

export type ServiceName = string;

const MAX_MONITORED_SERVICES = 200;

export interface DependencyGraph {
  getDependencies(service: ServiceName): Set<ServiceName>;
  getDependents(service: ServiceName): Set<ServiceName>;
  getAllServices(): Set<ServiceName>;
  addDependency(from: ServiceName, to: ServiceName): void;
  removeDependency(from: ServiceName, to: ServiceName): void;
}

export class InMemoryDependencyGraph implements DependencyGraph {
  private dependencies = new Map<ServiceName, Set<ServiceName>>();
  private dependents = new Map<ServiceName, Set<ServiceName>>();
  private allServices = new Set<ServiceName>();

  constructor(dependenciesConfig?: Record<string, unknown>) {
    if (dependenciesConfig) {
      this.loadFromConfig(dependenciesConfig);
    }
  }

  static fromYamlFile(filePath: string): InMemoryDependencyGraph {
    return new InMemoryDependencyGraph(parseDependencyYaml(readFileSync(filePath, 'utf8')));
  }

  loadFromConfig(config: Record<string, unknown>): void {
    this.dependencies.clear();
    this.dependents.clear();
    this.allServices.clear();

    const normalized = this.normalizeConfig(config);
    if (normalized.size > MAX_MONITORED_SERVICES) {
      throw new Error(
        `Dependency graph contains ${normalized.size} services, maximum is ${MAX_MONITORED_SERVICES}`,
      );
    }

    for (const [service, deps] of normalized.entries()) {
      this.allServices.add(service);
      if (!this.dependencies.has(service)) {
        this.dependencies.set(service, new Set());
      }

      for (const dep of deps) {
        this.allServices.add(dep);
        this.dependencies.get(service)!.add(dep);
        if (!this.dependents.has(dep)) {
          this.dependents.set(dep, new Set());
        }
        this.dependents.get(dep)!.add(service);
      }
    }
  }

  getDependencies(service: ServiceName): Set<ServiceName> {
    return new Set(this.dependencies.get(service) ?? []);
  }

  getDependents(service: ServiceName): Set<ServiceName> {
    return new Set(this.dependents.get(service) ?? []);
  }

  getAllServices(): Set<ServiceName> {
    return new Set(this.allServices);
  }

  addDependency(from: ServiceName, to: ServiceName): void {
    const newServices = new Set([from, to]);
    for (const service of this.allServices) {
      newServices.delete(service);
    }
    if (this.allServices.size + newServices.size > MAX_MONITORED_SERVICES) {
      throw new Error(`Cannot add dependency: maximum monitored services is ${MAX_MONITORED_SERVICES}`);
    }

    this.allServices.add(from);
    this.allServices.add(to);
    if (!this.dependencies.has(from)) {
      this.dependencies.set(from, new Set());
    }
    this.dependencies.get(from)!.add(to);
    if (!this.dependents.has(to)) {
      this.dependents.set(to, new Set());
    }
    this.dependents.get(to)!.add(from);
  }

  removeDependency(from: ServiceName, to: ServiceName): void {
    this.dependencies.get(from)?.delete(to);
    this.dependents.get(to)?.delete(from);
  }

  private normalizeConfig(config: Record<string, unknown>): Map<string, string[]> {
    const source = config.dependencies &&
      typeof config.dependencies === 'object' &&
      !Array.isArray(config.dependencies)
      ? config.dependencies as Record<string, unknown>
      : config;
    const normalized = new Map<string, string[]>();

    for (const [service, rawDeps] of Object.entries(source)) {
      const deps = Array.isArray(rawDeps)
        ? rawDeps
            .flat()
            .filter((dep): dep is string => typeof dep === 'string' && dep.trim().length > 0)
            .map(dep => dep.trim())
        : [];

      normalized.set(service, deps);
      for (const dep of deps) {
        if (!normalized.has(dep)) {
          normalized.set(dep, []);
        }
      }
    }
    return normalized;
  }
}

export function parseDependencyYaml(content: string): Record<string, string[]> {
  const config: Record<string, string[]> = {};
  let currentService: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trimEnd();
    if (!line.trim()) {
      continue;
    }

    const serviceMatch = /^([A-Za-z0-9_.-]+):\s*(?:\[(.*)\])?\s*$/.exec(line);
    if (serviceMatch && !rawLine.startsWith(' ') && !rawLine.startsWith('\t')) {
      currentService = serviceMatch[1];
      const inlineList = serviceMatch[2];
      config[currentService] = inlineList
        ? inlineList.split(',').map(dep => dep.trim()).filter(Boolean)
        : [];
      continue;
    }

    const dependencyMatch = /^\s*-\s*(.*)\s*$/.exec(line);
    if (dependencyMatch && currentService) {
      const dependency = dependencyMatch[1].trim();
      if (dependency && dependency !== '[]') {
        config[currentService].push(dependency);
      }
    }
  }

  return config;
}
