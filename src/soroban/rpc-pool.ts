import * as dns from 'dns/promises';
import { sorobanConfig } from '../config/soroban';
import { HealthChecker } from './health-checker';
import { CircuitBreaker } from './circuit-breaker';

export interface RpcNode {
  url: string;
  circuitBreaker: CircuitBreaker;
}

export class RpcPool {
  private nodes: Map<string, RpcNode> = new Map();
  private discoveryInterval?: NodeJS.Timeout;
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(private healthChecker: HealthChecker) {}

  public async start(): Promise<void> {
    await this.discoverNodes();
    this.discoveryInterval = setInterval(() => this.discoverNodes(), sorobanConfig.discoveryIntervalMs);
    this.healthCheckInterval = setInterval(() => this.runHealthChecks(), sorobanConfig.healthCheckIntervalMs);
  }

  public stop(): void {
    if (this.discoveryInterval) clearInterval(this.discoveryInterval);
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
  }

  public getNodes(): RpcNode[] {
    return Array.from(this.nodes.values());
  }

  private async discoverNodes(): Promise<void> {
    try {
      const records = await dns.resolveSrv(sorobanConfig.srvRecord);
      const currentUrls = new Set<string>();

      for (const record of records) {
        const url = `http://${record.name}:${record.port}`;
        currentUrls.add(url);

        if (!this.nodes.has(url)) {
          this.nodes.set(url, {
            url,
            circuitBreaker: new CircuitBreaker({
              failureThreshold: 5,
              recoveryTimeoutMs: 30000,
            }),
          });
          this.healthChecker.registerNode(url);
        }
      }

      // Remove stale nodes
      for (const url of this.nodes.keys()) {
        if (!currentUrls.has(url)) {
          this.nodes.delete(url);
          this.healthChecker.unregisterNode(url);
        }
      }
    } catch (err) {
      console.error('Failed to discover Soroban nodes:', err);
    }
  }

  private async runHealthChecks(): Promise<void> {
    const promises = Array.from(this.nodes.keys()).map(url => this.healthChecker.runCheck(url));
    await Promise.all(promises);
  }
}
