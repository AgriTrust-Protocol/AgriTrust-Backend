/**
 * Cross-Grid Commodity Re-Allocation Optimization — Solver Engine
 *
 * Implements a minimum-cost flow solver using the Successive Shortest Path
 * (SSP) algorithm with Johnson's potentials for reduced costs.
 *
 * Given a TransportNetwork, supply/demand parameters, and the pre-computed
 * cost matrix from buildCostMatrix(), the solver:
 *   1. Determines which nodes are surplus sources and which are deficit sinks.
 *   2. Iteratively routes flow along the cheapest augmenting path (Dijkstra
 *      with reduced costs to handle negative reduced edges after potential
 *      updates).
 *   3. Produces a list of TransportPlan records ordered by cost efficiency
 *      (cost per ton), returning the top 5.
 *
 * Complexity: suitable for ≤500 nodes / 10 000 edges within a 10-second
 * wall-clock budget.
 */

import { TransportNetwork, TransportPlan, Edge } from './models';
import { buildCostMatrix, reconstructPath, ShortestPathResult } from './network_graph';

// ---------------------------------------------------------------------------
// Internal residual-graph types for SSP
// ---------------------------------------------------------------------------

interface ResidualEdge {
  to: number;
  cap: number;
  cost: number; // effective cost per ton (costPerTonKm * distanceKm)
  flow: number;
  rev: number; // index of reverse edge in adjacency list of `to`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OptimizationRequest {
  network: TransportNetwork;
  /**
   * Demand requirements: map of node ID → tons required at that destination.
   * Nodes not listed have zero demand.
   */
  demand: Record<string, number>;
  /**
   * Maximum number of plans to return (default 5).
   */
  topK?: number;
}

export interface OptimizationResult {
  plans: TransportPlan[];
  totalCost: number;
  /** Whether the solver satisfied all demands within inventory constraints */
  feasible: boolean;
  /** Wall-clock time consumed by the solver in milliseconds */
  solverMs: number;
}

/**
 * Entry point: builds the cost matrix, runs the SSP min-cost flow solver,
 * and returns the top-K ranked TransportPlans.
 */
export function optimizeReallocation(request: OptimizationRequest): OptimizationResult {
  const t0 = Date.now();
  const topK = request.topK ?? 5;

  const { network, demand } = request;

  if (network.nodes.length === 0) {
    return { plans: [], totalCost: 0, feasible: true, solverMs: Date.now() - t0 };
  }

  // Build shortest-path matrix (Floyd-Warshall)
  const spResult = buildCostMatrix(network);
  const { nodeIndex } = spResult;
  const n = nodeIndex.length;
  const idxMap = new Map<string, number>(nodeIndex.map((id, i) => [id, i]));

  // Build per-node supply map (positive = surplus, negative = deficit)
  const supply = new Map<number, number>();
  for (const node of network.nodes) {
    const idx = idxMap.get(node.id);
    if (idx === undefined) continue;
    supply.set(idx, node.inventoryAvailable);
  }

  // Demand reduces supply at destination nodes
  const demandMap = new Map<number, number>();
  for (const [nodeId, tons] of Object.entries(demand)) {
    const idx = idxMap.get(nodeId);
    if (idx === undefined) continue;
    demandMap.set(idx, tons);
  }

  const edgeIdxMap = new Map<string, Edge[]>();
  for (const edge of network.edges) {
    const key = `${edge.from}:${edge.to}`;
    if (!edgeIdxMap.has(key)) edgeIdxMap.set(key, []);
    edgeIdxMap.get(key)!.push(edge);
  }

  // Add super-source (index n) and super-sink (index n+1)
  const S = n;
  const T = n + 1;
  const totalNodes = n + 2;

  const extGraph: ResidualEdge[][] = Array.from({ length: totalNodes }, () => []);

  function addExtEdge(u: number, v: number, cap: number, cost: number): void {
    extGraph[u].push({ to: v, cap, cost, flow: 0, rev: extGraph[v].length });
    extGraph[v].push({ to: u, cap: 0, cost: -cost, flow: 0, rev: extGraph[u].length - 1 });
  }

  // Add actual network edges
  for (const edge of network.edges) {
    const u = idxMap.get(edge.from);
    const v = idxMap.get(edge.to);
    if (u === undefined || v === undefined) continue;
    const cost = edge.costPerTonKm * edge.distanceKm;
    addExtEdge(u, v, edge.maxFlow, cost);
  }

  // Connect super-source to surplus nodes, deficit nodes to super-sink
  let totalDemand = 0;
  for (const [idx, sup] of supply.entries()) {
    const dem = demandMap.get(idx) ?? 0;
    const net = sup - dem;
    if (net > 0) {
      // Surplus: supply from S
      addExtEdge(S, idx, net, 0);
    } else if (net < 0) {
      // Deficit: absorb at T
      addExtEdge(idx, T, -net, 0);
      totalDemand += -net;
    }
  }
  // Nodes with only demand and no supply
  for (const [idx, dem] of demandMap.entries()) {
    if (!supply.has(idx) && dem > 0) {
      addExtEdge(idx, T, dem, 0);
      totalDemand += dem;
    }
  }

  // Run SSP with Dijkstra + potentials (Johnson's technique)
  const plans: TransportPlan[] = [];
  let totalCost = 0;
  let totalFlowSent = 0;

  // Johnson's initial potentials via Bellman-Ford from S
  const pot = new Array<number>(totalNodes).fill(Infinity);
  pot[S] = 0;
  for (let iter = 0; iter < totalNodes - 1; iter++) {
    let relaxed = false;
    for (let u = 0; u < totalNodes; u++) {
      if (pot[u] === Infinity) continue;
      for (const e of extGraph[u]) {
        if (e.cap > 0 && pot[u] + e.cost < pot[e.to]) {
          pot[e.to] = pot[u] + e.cost;
          relaxed = true;
        }
      }
      if (!relaxed) break;
    }
  }
  // Clamp unreachable potentials
  for (let i = 0; i < totalNodes; i++) {
    if (pot[i] === Infinity) pot[i] = 0;
  }

  // SSP main loop
  while (totalFlowSent < totalDemand) {
    // Dijkstra with reduced costs
    const dist2 = new Array<number>(totalNodes).fill(Infinity);
    const prevNode = new Array<number>(totalNodes).fill(-1);
    const prevEdge = new Array<number>(totalNodes).fill(-1);
    const visited = new Array<boolean>(totalNodes).fill(false);
    dist2[S] = 0;

    // Simple O(V²) Dijkstra — sufficient for ≤502 nodes
    for (let iter = 0; iter < totalNodes; iter++) {
      // Find unvisited node with minimum dist
      let u = -1;
      for (let v = 0; v < totalNodes; v++) {
        if (!visited[v] && dist2[v] < Infinity) {
          if (u === -1 || dist2[v] < dist2[u]) u = v;
        }
      }
      if (u === -1) break;
      visited[u] = true;

      for (let ei = 0; ei < extGraph[u].length; ei++) {
        const e = extGraph[u][ei];
        if (e.cap <= 0) continue;
        // Reduced cost = actual_cost - pot[u] + pot[v]  (Johnson)
        const reducedCost = e.cost - pot[u] + pot[e.to];
        if (dist2[u] + reducedCost < dist2[e.to]) {
          dist2[e.to] = dist2[u] + reducedCost;
          prevNode[e.to] = u;
          prevEdge[e.to] = ei;
        }
      }
    }

    if (dist2[T] === Infinity) break; // no augmenting path — infeasible

    // Update potentials
    for (let i = 0; i < totalNodes; i++) {
      if (dist2[i] < Infinity) pot[i] += dist2[i];
    }

    // Find bottleneck capacity along the path
    let bottleneck = totalDemand - totalFlowSent;
    let cur = T;
    while (cur !== S) {
      const u2 = prevNode[cur];
      const ei = prevEdge[cur];
      bottleneck = Math.min(bottleneck, extGraph[u2][ei].cap);
      cur = u2;
    }

    // Augment flow and collect (source, dest, quantity) pairs
    const pathEdges: Array<{ from: number; to: number; flow: number }> = [];
    cur = T;
    while (cur !== S) {
      const u2 = prevNode[cur];
      const ei = prevEdge[cur];
      const fwd = extGraph[u2][ei];
      const rev = extGraph[fwd.to][fwd.rev];
      fwd.cap -= bottleneck;
      fwd.flow += bottleneck;
      rev.cap += bottleneck;
      rev.flow -= bottleneck;
      if (u2 !== S && cur !== T) {
        pathEdges.push({ from: u2, to: cur, flow: bottleneck });
      }
      const realCost = fwd.cost * bottleneck;
      if (realCost > 0) totalCost += realCost;
      cur = u2;
    }
    totalFlowSent += bottleneck;

    // Derive TransportPlan from the path (skip super-source/sink edges)
    // Collect the real-network path between source node and dest node
    if (pathEdges.length > 0) {
      const srcNode = pathEdges[0].from;
      const dstNode = pathEdges[pathEdges.length - 1].to;
      const waypoints = pathEdges.slice(1).map((pe) => nodeIndex[pe.from]);
      const planCost = pathEdges.reduce((acc, pe) => {
        const key = `${nodeIndex[pe.from]}:${nodeIndex[pe.to]}`;
        const candidates = edgeIdxMap.get(key);
        const edgeCost = candidates
          ? candidates[0].costPerTonKm * candidates[0].distanceKm * pe.flow
          : 0;
        return acc + edgeCost;
      }, 0);

      plans.push({
        sourceSiloId: nodeIndex[srcNode],
        destSiloId: nodeIndex[dstNode],
        quantityTons: bottleneck,
        routeWaypoints: waypoints,
        estimatedCost: planCost,
        costPerTon: bottleneck > 0 ? planCost / bottleneck : 0,
      });
    }
  }

  const feasible = totalFlowSent >= totalDemand;

  // Rank by cost efficiency (ascending cost/ton), deduplicate by source+dest
  const merged = mergePlans(plans);
  merged.sort((a, b) => a.costPerTon - b.costPerTon);
  const top = merged.slice(0, topK);

  return {
    plans: top,
    totalCost,
    feasible,
    solverMs: Date.now() - t0,
  };
}

/**
 * Merges multiple TransportPlan entries that share the same source/dest pair
 * into a single combined plan (summing quantities and costs).
 */
function mergePlans(plans: TransportPlan[]): TransportPlan[] {
  const map = new Map<string, TransportPlan>();
  for (const p of plans) {
    const key = `${p.sourceSiloId}→${p.destSiloId}`;
    if (!map.has(key)) {
      map.set(key, { ...p });
    } else {
      const existing = map.get(key)!;
      existing.quantityTons += p.quantityTons;
      existing.estimatedCost += p.estimatedCost;
      existing.costPerTon =
        existing.quantityTons > 0 ? existing.estimatedCost / existing.quantityTons : 0;
    }
  }
  return Array.from(map.values());
}

// Re-export graph helpers so the API layer has a single import surface
export { buildCostMatrix, reconstructPath };
export type { ShortestPathResult };
