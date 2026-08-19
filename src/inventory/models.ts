/**
 * Cross-Grid Commodity Re-Allocation Optimization — Data Models
 *
 * Defines the core structs used by the transport network optimizer:
 *   - Node  — a silo, farm, or port with inventory attributes
 *   - Edge  — a directed transport route between two nodes
 *   - TransportNetwork — the full weighted directed graph
 *   - TransportPlan — a single recommended redistribution plan
 */

export interface Node {
  /** Unique identifier (silo/farm/port ID) */
  id: string;
  /** Available inventory in tons */
  inventoryAvailable: number;
  /** Maximum storage capacity in tons */
  capacity: number;
  /** Daily throughput rate in tons/day */
  outflowRate: number;
  /** Commodity quality descriptor, e.g. { moisture: 12, grade: 'A' } */
  qualityProfile: Record<string, unknown>;
}

export interface Edge {
  /** Source node ID */
  from: string;
  /** Destination node ID */
  to: string;
  /** Transportation cost per ton per km (USD/ton·km) */
  costPerTonKm: number;
  /** Route distance in km */
  distanceKm: number;
  /** Maximum tons that can be routed along this edge */
  maxFlow: number;
}

export interface TransportNetwork {
  nodes: Node[];
  edges: Edge[];
}

export interface TransportPlan {
  /** Source silo/node ID */
  sourceSiloId: string;
  /** Destination silo/node ID */
  destSiloId: string;
  /** Quantity to transfer in tons */
  quantityTons: number;
  /** Ordered list of intermediate node IDs (empty for direct routes) */
  routeWaypoints: string[];
  /** Total estimated transportation cost (USD) */
  estimatedCost: number;
  /** Cost efficiency: cost per ton (USD/ton) */
  costPerTon: number;
}
