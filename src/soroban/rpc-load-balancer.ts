import { sorobanConfig } from '../config/soroban';
import { HealthChecker, NodeStatus } from './health-checker';
import { RpcPool, RpcNode } from './rpc-pool';
import { CircuitState } from './circuit-breaker';

export interface AffinityKey {
  sourceLedger: string;
  nonce: string;
}

export class RpcLoadBalancer {
  private affinityMap: Map<string, { nodeUrl: string; expiresAt: number }> = new Map();

  constructor(
    private pool: RpcPool,
    private healthChecker: HealthChecker,
  ) {
    setInterval(() => this.cleanupAffinity(), 5000);
  }

  public select(affinity?: AffinityKey): string {
    const key = affinity ? `${affinity.sourceLedger}:${affinity.nonce}` : undefined;

    if (key) {
      const entry = this.affinityMap.get(key);
      if (entry && entry.expiresAt > Date.now()) {
        const status = this.healthChecker.getStatus(entry.nodeUrl);
        if (status.status === NodeStatus.ACTIVE) {
          entry.expiresAt = Date.now() + sorobanConfig.affinityTimeoutMs;
          return entry.nodeUrl;
        }
      }
    }

    const nodeUrl = this.weightedRandomSelection();
    if (key) {
      this.affinityMap.set(key, {
        nodeUrl,
        expiresAt: Date.now() + sorobanConfig.affinityTimeoutMs,
      });
    }
    return nodeUrl;
  }

  public async reportResult(nodeUrl: string, success: boolean): Promise<void> {
    const node = this.pool.getNodes().find(n => n.url === nodeUrl);
    if (!node) return;

    if (success) {
        // We can't easily call onSuccess without executing something,
        // but we can simulate it by wrapping a no-op if the breaker allowed it.
        await node.circuitBreaker.execute(async () => {});
    } else {
        await node.circuitBreaker.execute(async () => {
            throw new Error('Remote call failed');
        }).catch(() => {});

        // If the circuit breaker is now OPEN, mark the node as DEGRADED
        if (node.circuitBreaker.getState() === CircuitState.OPEN) {
            this.healthChecker.recordCheck(nodeUrl, false);
            this.healthChecker.recordCheck(nodeUrl, false);
            this.healthChecker.recordCheck(nodeUrl, false);
        }
    }
  }

  private weightedRandomSelection(): string {
    const nodes = this.pool.getNodes();
    const weights: { url: string; weight: number }[] = [];
    let totalWeight = 0;

    for (const node of nodes) {
      const statusInfo = this.healthChecker.getStatus(node.url);
      const circuitState = node.circuitBreaker.getState();

      if (circuitState === CircuitState.OPEN) continue;

      let weight = 0;
      if (statusInfo.status === NodeStatus.ACTIVE) {
        const p99 = Math.max(statusInfo.p99Latency, sorobanConfig.p99ThresholdMs);
        const errorFactor = Math.max(1 - statusInfo.errorRate, 0.01);
        weight = (1 / p99) * errorFactor;
      } else if (statusInfo.status === NodeStatus.DEGRADED) {
        const now = Date.now();
        if (statusInfo.recoveryStartTime) {
          const elapsed = now - statusInfo.recoveryStartTime;
          // Doubles every 30s to reach full weight in 120s (10% -> 20% -> 40% -> 80% -> 100%)
          const recoveryStepMs = sorobanConfig.recoveryDurationMs / 4; // 30,000ms
          const steps = Math.floor(elapsed / recoveryStepMs);
          const recoveryFactor = Math.min(
            sorobanConfig.weights.initialRecoveryWeight * Math.pow(2, steps),
            1.0
          );

          if (recoveryFactor >= 1.0 && elapsed >= sorobanConfig.recoveryDurationMs) {
            this.healthChecker.completeRecovery(node.url);
          }

          const p99 = Math.max(statusInfo.p99Latency, sorobanConfig.p99ThresholdMs);
          weight = (1 / p99) * recoveryFactor;
        } else if (now - (statusInfo.lastFailureTime || 0) > sorobanConfig.degradedTimeoutMs) {
          // Probe node
          this.probeNode(node.url);
        }
      }

      if (weight > 0) {
        weights.push({ url: node.url, weight });
        totalWeight += weight;
      }
    }

    if (weights.length === 0) {
      if (nodes.length > 0) return nodes[Math.floor(Math.random() * nodes.length)].url;
      throw new Error('No Soroban nodes available');
    }

    let random = Math.random() * totalWeight;
    for (const item of weights) {
      random -= item.weight;
      if (random <= 0) return item.url;
    }

    return weights[0].url;
  }

  private async probeNode(nodeUrl: string): Promise<void> {
    const success = await this.healthChecker.probeNode(nodeUrl);
    if (success) {
      this.healthChecker.startRecovery(nodeUrl);
    } else {
      const status = this.healthChecker.getStatus(nodeUrl);
      status.lastFailureTime = Date.now();
    }
  }

  private cleanupAffinity(): void {
    const now = Date.now();
    for (const [key, affinity] of this.affinityMap.entries()) {
      if (affinity.expiresAt < now) {
        this.affinityMap.delete(key);
      }
    }
  }
}
