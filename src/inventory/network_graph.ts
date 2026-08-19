/**
 * Cross-Grid Commodity Re-Allocation Optimization — Network Graph
 *
 * Builds and exposes the weighted directed graph representation of the
 * transport network, and computes the all-pairs shortest-path cost matrix
 * using Floyd-Warshall (O(n³), suitable for ≤500 nodes / 10 000 edges).
 */

import { TransportNetwork, Edge } from './models';

export interface ShortestPathResult {
  /** dist[i][j] = minimum cost (USD/ton) from node i to node j */
  dist: number[][];
  /** next[i][j] = the next node index along the shortest path from i to j */
  next: (number | null)[][];
  /** Ordered index of node IDs (position → id) */
  nodeIndex: string[];
}

/**
 * Computes the effective cost of traversing a single edge.
 * cost = costPerTonKm * distanceKm
 */
export function edgeEffectiveCost(edge: Edge): number {
  return edge.costPerTonKm * edge.distanceKm;
}

/**
 * Builds the all-pairs shortest-path cost matrix over the transport network
 * using Floyd-Warshall with edge weights = costPerTonKm * distanceKm.
 *
 * Complexity: O(n³) — for n ≤ 500 this runs well within 10 seconds.
 *
 * @param network — the TransportNetwork to analyse
 * @returns ShortestPathResult containing dist matrix, next matrix, and node index
 */
export function buildCostMatrix(network: TransportNetwork): ShortestPathResult {
  const nodeIndex = network.nodes.map((n) => n.id);
  const n = nodeIndex.length;
  const idxMap = new Map<string, number>(nodeIndex.map((id, i) => [id, i]));

  // Initialise distance matrix with Infinity and self-paths with 0
  const dist: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)),
  );
  const next: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? i : null)),
  );

  // Populate direct edge weights
  for (const edge of network.edges) {
    const u = idxMap.get(edge.from);
    const v = idxMap.get(edge.to);
    if (u === undefined || v === undefined) {
      continue; // skip edges referencing unknown nodes
    }
    const cost = edgeEffectiveCost(edge);
    if (cost < dist[u][v]) {
      dist[u][v] = cost;
      next[u][v] = v;
    }
  }

  // Floyd-Warshall relaxation
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      if (dist[i][k] === Infinity) continue; // prune unreachable
      for (let j = 0; j < n; j++) {
        const through = dist[i][k] + dist[k][j];
        if (through < dist[i][j]) {
          dist[i][j] = through;
          next[i][j] = next[i][k];
        }
      }
    }
  }

  return { dist, next, nodeIndex };
}

/**
 * Reconstructs the waypoints (excluding source) along the shortest path from
 * node `src` to node `dst` using the `next` matrix from buildCostMatrix.
 *
 * Returns null if no path exists.
 */
export function reconstructPath(
  src: number,
  dst: number,
  result: ShortestPathResult,
): string[] | null {
  const { next, nodeIndex } = result;
  if (next[src][dst] === null) return null;

  const path: string[] = [];
  let cur = src;
  while (cur !== dst) {
    const nx = next[cur][dst];
    if (nx === null) return null; // disconnected
    path.push(nodeIndex[nx]);
    cur = nx;
  }
  // path now contains nodes from (src's next) through dst inclusive
  return path;
}
