import { RingBuffer } from '../websocket/ring-buffer';
import { sorobanConfig } from '../config/soroban';
import { rpcPoolSize, rpcRequestDurationMs, rpcErrorTotal } from '../api/metrics/registry';

export enum NodeStatus {
  ACTIVE = 'active',
  DEGRADED = 'degraded',
  DEAD = 'dead',
}

export interface NodeHealthInfo {
  status: NodeStatus;
  p99Latency: number;
  errorRate: number;
  lastFailureTime?: number;
  recoveryStartTime?: number;
}

export class HealthChecker {
  private healthHistory: Map<string, RingBuffer<boolean>> = new Map();
  private latencies: Map<string, number[]> = new Map();
  private statuses: Map<string, NodeHealthInfo> = new Map();

  constructor() {}

  public registerNode(nodeUrl: string): void {
    if (!this.healthHistory.has(nodeUrl)) {
      this.healthHistory.set(nodeUrl, new RingBuffer<boolean>(5));
      this.latencies.set(nodeUrl, []);
      this.statuses.set(nodeUrl, {
        status: NodeStatus.ACTIVE,
        p99Latency: 50,
        errorRate: 0,
      });
      this.updatePoolMetrics();
    }
  }

  public unregisterNode(nodeUrl: string): void {
    this.healthHistory.delete(nodeUrl);
    this.latencies.delete(nodeUrl);
    this.statuses.delete(nodeUrl);
    this.updatePoolMetrics();
  }

  private updatePoolMetrics(): void {
    const counts = { active: 0, degraded: 0, dead: 0 };
    for (const info of this.statuses.values()) {
      counts[info.status]++;
    }
    rpcPoolSize.set({ status: 'active' }, counts.active);
    rpcPoolSize.set({ status: 'degraded' }, counts.degraded);
    rpcPoolSize.set({ status: 'dead' }, counts.dead);
  }

  public async runCheck(nodeUrl: string): Promise<void> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      const response = await fetch(nodeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestLedger',
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const latency = Date.now() - start;
      const success = response.ok;

      this.recordCheck(nodeUrl, success, latency);
      rpcRequestDurationMs.observe({ node: nodeUrl }, latency);
      if (!success) {
        rpcErrorTotal.inc({ node: nodeUrl, code: String(response.status) });
      }
    } catch (err) {
      this.recordCheck(nodeUrl, false);
      rpcErrorTotal.inc({ node: nodeUrl, code: 'FETCH_ERROR' });
    }
  }

  public async probeNode(nodeUrl: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(nodeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getHealth',
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  public recordCheck(nodeUrl: string, success: boolean, latency?: number): void {
    const history = this.healthHistory.get(nodeUrl);
    if (!history) return;

    history.push(success);
    if (success && latency !== undefined) {
      const nodeLatencies = this.latencies.get(nodeUrl)!;
      nodeLatencies.push(latency);
      if (nodeLatencies.length > 100) nodeLatencies.shift();
    }

    this.updateStatus(nodeUrl);
  }

  public getStatus(nodeUrl: string): NodeHealthInfo {
    return this.statuses.get(nodeUrl) || {
      status: NodeStatus.DEAD,
      p99Latency: 1000,
      errorRate: 1.0,
    };
  }

  private updateStatus(nodeUrl: string): void {
    const history = this.healthHistory.get(nodeUrl)!;
    const statusInfo = this.statuses.get(nodeUrl)!;
    const oldStatus = statusInfo.status;

    // Check for 3 consecutive failures
    let consecutiveFailures = 0;
    const items = Array.from(history);
    for (let i = items.length - 1; i >= 0; i--) {
      if (!items[i]) {
        consecutiveFailures++;
      } else {
        break;
      }
    }

    if (consecutiveFailures >= 3 && statusInfo.status !== NodeStatus.DEGRADED) {
      statusInfo.status = NodeStatus.DEGRADED;
      statusInfo.lastFailureTime = Date.now();
      statusInfo.recoveryStartTime = undefined;
    }

    // Calculate error rate and p99
    const totalChecks = items.length;
    const failures = items.filter(s => !s).length;
    statusInfo.errorRate = totalChecks > 0 ? failures / totalChecks : 0;

    const nodeLatencies = this.latencies.get(nodeUrl)!;
    if (nodeLatencies.length > 0) {
      const sorted = [...nodeLatencies].sort((a, b) => a - b);
      const idx = Math.floor(sorted.length * 0.99);
      statusInfo.p99Latency = sorted[idx];
    }

    if (oldStatus !== statusInfo.status) {
      this.updatePoolMetrics();
    }
  }

  public startRecovery(nodeUrl: string): void {
    const statusInfo = this.statuses.get(nodeUrl);
    if (statusInfo && statusInfo.status === NodeStatus.DEGRADED) {
      statusInfo.recoveryStartTime = Date.now();
    }
  }

  public completeRecovery(nodeUrl: string): void {
    const statusInfo = this.statuses.get(nodeUrl);
    if (statusInfo) {
      statusInfo.status = NodeStatus.ACTIVE;
      statusInfo.recoveryStartTime = undefined;
      statusInfo.lastFailureTime = undefined;
      this.updatePoolMetrics();
    }
  }
}
