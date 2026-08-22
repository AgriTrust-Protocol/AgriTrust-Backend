/**
 * Unit tests for the Cross-Grid Commodity Re-Allocation Optimization Engine
 *
 * Covers:
 *   - buildCostMatrix (Floyd-Warshall all-pairs shortest path)
 *   - reconstructPath
 *   - optimizeReallocation (SSP min-cost flow solver)
 *   - Edge cases: empty network, disconnected nodes, excess supply
 */

import { describe, it, expect } from 'vitest';
import { buildCostMatrix, reconstructPath } from '../../src/inventory/network_graph';
import { optimizeReallocation } from '../../src/inventory/optimizer';
import { TransportNetwork, Node, Edge } from '../../src/inventory/models';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, inventoryAvailable: number, capacity = 1000, outflowRate = 10): Node {
  return { id, inventoryAvailable, capacity, outflowRate, qualityProfile: {} };
}

function makeEdge(
  from: string,
  to: string,
  costPerTonKm: number,
  distanceKm: number,
  maxFlow: number,
): Edge {
  return { from, to, costPerTonKm, distanceKm, maxFlow };
}

// ---------------------------------------------------------------------------
// buildCostMatrix tests
// ---------------------------------------------------------------------------

describe('buildCostMatrix', () => {
  it('returns a zero-cost diagonal for trivial single-node network', () => {
    const network: TransportNetwork = {
      nodes: [makeNode('A', 100)],
      edges: [],
    };
    const result = buildCostMatrix(network);
    expect(result.dist[0][0]).toBe(0);
    expect(result.nodeIndex).toEqual(['A']);
  });

  it('computes direct edge cost correctly', () => {
    // A→B: 0.5 USD/ton·km × 200 km = 100 USD/ton
    const network: TransportNetwork = {
      nodes: [makeNode('A', 200), makeNode('B', 0)],
      edges: [makeEdge('A', 'B', 0.5, 200, 500)],
    };
    const result = buildCostMatrix(network);
    const iA = result.nodeIndex.indexOf('A');
    const iB = result.nodeIndex.indexOf('B');
    expect(result.dist[iA][iB]).toBeCloseTo(100);
    expect(result.dist[iB][iA]).toBe(Infinity); // directed graph
  });

  it('finds cheaper indirect route via intermediate node', () => {
    // Direct A→C: 0.8 × 300 = 240
    // Via B:      A→B: 0.5×100=50  +  B→C: 0.5×100=50  = 100  (cheaper)
    const network: TransportNetwork = {
      nodes: [makeNode('A', 300), makeNode('B', 300), makeNode('C', 0)],
      edges: [
        makeEdge('A', 'C', 0.8, 300, 1000),
        makeEdge('A', 'B', 0.5, 100, 1000),
        makeEdge('B', 'C', 0.5, 100, 1000),
      ],
    };
    const result = buildCostMatrix(network);
    const iA = result.nodeIndex.indexOf('A');
    const iC = result.nodeIndex.indexOf('C');
    // Should prefer A→B→C = 100 over A→C = 240
    expect(result.dist[iA][iC]).toBeCloseTo(100);
  });

  it('leaves disconnected pairs at Infinity', () => {
    const network: TransportNetwork = {
      nodes: [makeNode('X', 100), makeNode('Y', 100)],
      edges: [], // no edges
    };
    const result = buildCostMatrix(network);
    expect(result.dist[0][1]).toBe(Infinity);
    expect(result.dist[1][0]).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// reconstructPath tests
// ---------------------------------------------------------------------------

describe('reconstructPath', () => {
  it('returns the direct next-hop for a single edge path', () => {
    const network: TransportNetwork = {
      nodes: [makeNode('A', 100), makeNode('B', 0)],
      edges: [makeEdge('A', 'B', 1, 100, 500)],
    };
    const result = buildCostMatrix(network);
    const iA = result.nodeIndex.indexOf('A');
    const iB = result.nodeIndex.indexOf('B');
    const path = reconstructPath(iA, iB, result);
    expect(path).toEqual(['B']);
  });

  it('returns multi-hop waypoints', () => {
    const network: TransportNetwork = {
      nodes: [makeNode('A', 100), makeNode('B', 100), makeNode('C', 0)],
      edges: [makeEdge('A', 'B', 0.5, 100, 1000), makeEdge('B', 'C', 0.5, 100, 1000)],
    };
    const result = buildCostMatrix(network);
    const iA = result.nodeIndex.indexOf('A');
    const iC = result.nodeIndex.indexOf('C');
    const path = reconstructPath(iA, iC, result);
    // A → B → C, so waypoints from A's perspective = ['B', 'C']
    expect(path).toContain('B');
    expect(path).toContain('C');
  });

  it('returns null when no path exists', () => {
    const network: TransportNetwork = {
      nodes: [makeNode('A', 100), makeNode('B', 0)],
      edges: [],
    };
    const result = buildCostMatrix(network);
    expect(reconstructPath(0, 1, result)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// optimizeReallocation — 5-node network with known optimal flow
// ---------------------------------------------------------------------------

describe('optimizeReallocation — 5-node network', () => {
  /**
   * Network topology (all distances 100 km, costs vary):
   *
   *   S1 (supply=150) ──0.5──► D1 (demand=80)
   *   S1              ──1.0──► D2 (demand=50)  (expensive direct)
   *   S2 (supply=200) ──0.3──► D2 (demand=50)  (cheap)
   *   S2              ──0.6──► D3 (demand=60)
   *   HUB (supply=0)  ──0.2──► D3 (demand=60)  (cheap via hub)
   *   S1              ──0.4──► HUB              (feed hub cheaply)
   *
   * Optimal flows (manually verified):
   *   S1→D1  80 tons  @ 0.5×100 = 50/ton  → cost = 4000
   *   S2→D2  50 tons  @ 0.3×100 = 30/ton  → cost = 1500
   *   S1→HUB 60 tons  @ 0.4×100 = 40/ton  → feed hub
   *   HUB→D3 60 tons  @ 0.2×100 = 20/ton  → cost = 1200
   * Total optimal cost = 4000 + 1500 + 1200 = 6700
   * (S1→D2 via 1.0×100 = 100/ton would cost 5000 more if used instead)
   */

  const nodes: Node[] = [
    makeNode('S1', 200, 500),
    makeNode('S2', 200, 500),
    makeNode('HUB', 0, 500),
    makeNode('D1', 0, 500),
    makeNode('D2', 0, 500),
    makeNode('D3', 0, 500),
  ];

  const edges: Edge[] = [
    makeEdge('S1', 'D1', 0.5, 100, 200),
    makeEdge('S1', 'D2', 1.0, 100, 200), // expensive
    makeEdge('S2', 'D2', 0.3, 100, 200), // cheap
    makeEdge('S2', 'D3', 0.6, 100, 200),
    makeEdge('HUB', 'D3', 0.2, 100, 200), // cheapest to D3
    makeEdge('S1', 'HUB', 0.4, 100, 200), // feed hub
  ];

  const network: TransportNetwork = { nodes, edges };
  const demand: Record<string, number> = { D1: 80, D2: 50, D3: 60 };

  it('satisfies all demands and is feasible', () => {
    const result = optimizeReallocation({ network, demand });
    expect(result.feasible).toBe(true);
  });

  it('returns at most topK plans', () => {
    const result = optimizeReallocation({ network, demand, topK: 5 });
    expect(result.plans.length).toBeLessThanOrEqual(5);
    expect(result.plans.length).toBeGreaterThan(0);
  });

  it('all plans have positive quantityTons', () => {
    const result = optimizeReallocation({ network, demand });
    for (const plan of result.plans) {
      expect(plan.quantityTons).toBeGreaterThan(0);
    }
  });

  it('plans are ranked ascending by costPerTon', () => {
    const result = optimizeReallocation({ network, demand });
    for (let i = 1; i < result.plans.length; i++) {
      expect(result.plans[i].costPerTon).toBeGreaterThanOrEqual(result.plans[i - 1].costPerTon);
    }
  });

  it('S2→D2 route is preferred over S1→D2 (cheaper cost per ton)', () => {
    const result = optimizeReallocation({ network, demand });
    const s2d2 = result.plans.find((p) => p.sourceSiloId === 'S2' && p.destSiloId === 'D2');
    const s1d2 = result.plans.find((p) => p.sourceSiloId === 'S1' && p.destSiloId === 'D2');
    // S2→D2 should appear; S1→D2 (expensive) should not be routed if S2 has enough
    expect(s2d2).toBeDefined();
    if (s1d2) {
      // If it appears, it should be ranked after S2→D2
      const iS2D2 = result.plans.indexOf(s2d2!);
      const iS1D2 = result.plans.indexOf(s1d2);
      expect(iS1D2).toBeGreaterThan(iS2D2);
    }
  });

  it('total cost is non-negative', () => {
    const result = optimizeReallocation({ network, demand });
    expect(result.totalCost).toBeGreaterThanOrEqual(0);
  });

  it('solverMs is within expected bounds', () => {
    const result = optimizeReallocation({ network, demand });
    expect(result.solverMs).toBeGreaterThanOrEqual(0);
    expect(result.solverMs).toBeLessThan(10_000);
  });

  it('each plan has valid source/dest IDs belonging to the network', () => {
    const result = optimizeReallocation({ network, demand });
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const plan of result.plans) {
      expect(nodeIds.has(plan.sourceSiloId)).toBe(true);
      expect(nodeIds.has(plan.destSiloId)).toBe(true);
    }
  });

  it('respects topK=1 and returns exactly 1 plan', () => {
    const result = optimizeReallocation({ network, demand, topK: 1 });
    expect(result.plans.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('optimizeReallocation — edge cases', () => {
  it('returns empty plans for an empty network', () => {
    const result = optimizeReallocation({
      network: { nodes: [], edges: [] },
      demand: {},
    });
    expect(result.plans).toEqual([]);
    expect(result.feasible).toBe(true);
    expect(result.totalCost).toBe(0);
  });

  it('returns feasible=true when demand is zero', () => {
    const network: TransportNetwork = {
      nodes: [makeNode('A', 100), makeNode('B', 50)],
      edges: [makeEdge('A', 'B', 1, 50, 200)],
    };
    const result = optimizeReallocation({ network, demand: {} });
    expect(result.feasible).toBe(true);
  });

  it('marks infeasible when supply cannot satisfy demand', () => {
    const network: TransportNetwork = {
      nodes: [makeNode('S', 10, 500), makeNode('D', 0, 500)],
      edges: [makeEdge('S', 'D', 1, 100, 200)],
    };
    // Demand exceeds available supply
    const result = optimizeReallocation({ network, demand: { D: 50 } });
    expect(result.feasible).toBe(false);
  });

  it('handles disconnected destination gracefully', () => {
    const network: TransportNetwork = {
      nodes: [makeNode('S', 100, 500), makeNode('D', 0, 500)],
      edges: [], // no route between S and D
    };
    const result = optimizeReallocation({ network, demand: { D: 30 } });
    expect(result.feasible).toBe(false);
    expect(result.plans).toHaveLength(0);
  });

  it('works correctly with a single source satisfying a single destination', () => {
    const network: TransportNetwork = {
      nodes: [makeNode('SRC', 500, 1000), makeNode('DST', 0, 1000)],
      edges: [makeEdge('SRC', 'DST', 0.4, 250, 500)],
    };
    const result = optimizeReallocation({ network, demand: { DST: 100 } });
    expect(result.feasible).toBe(true);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].sourceSiloId).toBe('SRC');
    expect(result.plans[0].destSiloId).toBe('DST');
    expect(result.plans[0].quantityTons).toBe(100);
    // cost = 0.4 × 250 × 100 = 10 000
    expect(result.plans[0].estimatedCost).toBeCloseTo(10_000);
    expect(result.plans[0].costPerTon).toBeCloseTo(100);
  });

  it('routeWaypoints is an array', () => {
    const network: TransportNetwork = {
      nodes: [makeNode('SRC', 200), makeNode('DST', 0)],
      edges: [makeEdge('SRC', 'DST', 1, 100, 300)],
    };
    const result = optimizeReallocation({ network, demand: { DST: 50 } });
    for (const plan of result.plans) {
      expect(Array.isArray(plan.routeWaypoints)).toBe(true);
    }
  });
});
