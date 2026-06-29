import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthChecker, NodeStatus } from '../../src/soroban/health-checker';
import { RpcPool } from '../../src/soroban/rpc-pool';
import { RpcLoadBalancer, AffinityKey } from '../../src/soroban/rpc-load-balancer';
import { CircuitState } from '../../src/soroban/circuit-breaker';
import * as dns from 'dns/promises';

vi.mock('dns/promises');

describe('Soroban Load Balancer', () => {
  let healthChecker: HealthChecker;
  let rpcPool: RpcPool;
  let loadBalancer: RpcLoadBalancer;

  beforeEach(() => {
    vi.useFakeTimers();
    healthChecker = new HealthChecker();
    rpcPool = new RpcPool(healthChecker);
    loadBalancer = new RpcLoadBalancer(rpcPool, healthChecker);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('RpcPool Discovery', () => {
    it('should discover nodes via SRV records', async () => {
      const mockRecords = [
        { name: 'node1.example.com', port: 8000, priority: 1, weight: 1 },
        { name: 'node2.example.com', port: 8000, priority: 1, weight: 1 },
      ];
      vi.mocked(dns.resolveSrv).mockResolvedValue(mockRecords);

      await rpcPool.start();

      const nodes = rpcPool.getNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes.map(n => n.url)).toContain('http://node1.example.com:8000');
      expect(nodes.map(n => n.url)).toContain('http://node2.example.com:8000');
    });
  });

  describe('HealthChecker State Transitions', () => {
    it('should mark node DEGRADED after 3 consecutive failures', () => {
      const nodeUrl = 'http://node1:8000';
      healthChecker.registerNode(nodeUrl);

      healthChecker.recordCheck(nodeUrl, false);
      expect(healthChecker.getStatus(nodeUrl).status).toBe(NodeStatus.ACTIVE);

      healthChecker.recordCheck(nodeUrl, false);
      expect(healthChecker.getStatus(nodeUrl).status).toBe(NodeStatus.ACTIVE);

      healthChecker.recordCheck(nodeUrl, false);
      expect(healthChecker.getStatus(nodeUrl).status).toBe(NodeStatus.DEGRADED);
    });

    it('should recover node status from DEGRADED to ACTIVE', () => {
      const nodeUrl = 'http://node1:8000';
      healthChecker.registerNode(nodeUrl);
      for(let i=0; i<3; i++) healthChecker.recordCheck(nodeUrl, false);
      expect(healthChecker.getStatus(nodeUrl).status).toBe(NodeStatus.DEGRADED);

      healthChecker.startRecovery(nodeUrl);
      healthChecker.completeRecovery(nodeUrl);
      expect(healthChecker.getStatus(nodeUrl).status).toBe(NodeStatus.ACTIVE);
    });
  });

  describe('RpcLoadBalancer Selection', () => {
    it('should use connection affinity if (sourceLedger, nonce) is provided', async () => {
      vi.mocked(dns.resolveSrv).mockResolvedValue([{ name: 'node1', port: 80, priority: 1, weight: 1 }]);
      await rpcPool.start();

      const affinity: AffinityKey = { sourceLedger: 'L1', nonce: 'N1' };
      const node1 = loadBalancer.select(affinity);
      const node2 = loadBalancer.select(affinity);

      expect(node1).toBe(node2);
      expect(node1).toBe('http://node1:80');
    });

    it('should perform weighted selection based on latency', async () => {
        vi.mocked(dns.resolveSrv).mockResolvedValue([
            { name: 'fast-node', port: 80, priority: 1, weight: 1 },
            { name: 'slow-node', port: 80, priority: 1, weight: 1 }
        ]);
        await rpcPool.start();

        healthChecker.recordCheck('http://fast-node:80', true, 50);
        healthChecker.recordCheck('http://slow-node:80', true, 500);

        let fastCount = 0;
        for(let i=0; i<100; i++) {
            if (loadBalancer.select() === 'http://fast-node:80') fastCount++;
        }
        expect(fastCount).toBeGreaterThan(80);
    });

    it('should mark node DEGRADED when circuit breaker trips via reportResult', async () => {
        const nodeUrl = 'http://broken-node:80';
        vi.mocked(dns.resolveSrv).mockResolvedValue([{ name: 'broken-node', port: 80, priority: 1, weight: 1 }]);
        await rpcPool.start();

        for(let i=0; i<5; i++) {
          await loadBalancer.reportResult(nodeUrl, false);
        }

        const node = rpcPool.getNodes()[0];
        expect(node.circuitBreaker.getState()).toBe(CircuitState.OPEN);
        expect(healthChecker.getStatus(nodeUrl).status).toBe(NodeStatus.DEGRADED);
      });

    it('should skip nodes with open circuit breakers', async () => {
        vi.mocked(dns.resolveSrv).mockResolvedValue([
            { name: 'healthy', port: 80, priority: 1, weight: 1 },
            { name: 'broken', port: 80, priority: 1, weight: 1 }
        ]);
        await rpcPool.start();

        for(let i=0; i<5; i++) {
            await loadBalancer.reportResult('http://broken:80', false);
        }

        for(let i=0; i<10; i++) {
            expect(loadBalancer.select()).toBe('http://healthy:80');
        }
    });

    it('should handle gradual weight restoration over 120s', async () => {
        const nodeUrl = 'http://node1:80';
        vi.mocked(dns.resolveSrv).mockResolvedValue([{ name: 'node1', port: 80, priority: 1, weight: 1 }]);
        await rpcPool.start();

        for(let i=0; i<3; i++) healthChecker.recordCheck(nodeUrl, false);
        expect(healthChecker.getStatus(nodeUrl).status).toBe(NodeStatus.DEGRADED);

        healthChecker.startRecovery(nodeUrl);
        vi.advanceTimersByTime(121000);

        loadBalancer.select();
        expect(healthChecker.getStatus(nodeUrl).status).toBe(NodeStatus.ACTIVE);
      });
  });
});
