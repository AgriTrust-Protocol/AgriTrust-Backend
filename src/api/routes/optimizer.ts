/**
 * Cross-Grid Commodity Re-Allocation Optimization — API Layer
 *
 * Exposes:
 *   POST /api/v1/optimizer/rebalance
 *
 * Accepts a TransportNetwork + demand map, runs the min-cost flow optimizer,
 * and returns the top-5 ranked TransportPlans.
 */

import { Router, Request, Response } from 'express';
import { optimizeReallocation, OptimizationRequest } from '../../inventory/optimizer';
import { TransportNetwork } from '../../inventory/models';

export function createOptimizerRouter(): Router {
  const router = Router();

  /**
   * POST /rebalance
   *
   * Request body:
   * {
   *   "network": {
   *     "nodes": [ { "id", "inventoryAvailable", "capacity", "outflowRate", "qualityProfile" } ],
   *     "edges": [ { "from", "to", "costPerTonKm", "distanceKm", "maxFlow" } ]
   *   },
   *   "demand": { "<nodeId>": <tons>, ... },
   *   "topK": 5   // optional, defaults to 5
   * }
   *
   * Response 200:
   * {
   *   "plans": [ TransportPlan... ],
   *   "totalCost": number,
   *   "feasible": boolean,
   *   "solverMs": number
   * }
   */
  router.post('/rebalance', (req: Request, res: Response) => {
    try {
      const body = req.body as {
        network?: unknown;
        demand?: unknown;
        topK?: unknown;
      };

      // Basic validation
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Request body must be a JSON object' });
        return;
      }

      const network = body.network as TransportNetwork | undefined;
      if (!network || !Array.isArray(network.nodes) || !Array.isArray(network.edges)) {
        res
          .status(400)
          .json({ error: '`network` must contain `nodes` and `edges` arrays' });
        return;
      }

      const demand = body.demand;
      if (!demand || typeof demand !== 'object' || Array.isArray(demand)) {
        res.status(400).json({ error: '`demand` must be an object mapping node IDs to ton quantities' });
        return;
      }

      const topK =
        body.topK !== undefined
          ? Number(body.topK)
          : 5;

      if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
        res.status(400).json({ error: '`topK` must be an integer between 1 and 100' });
        return;
      }

      // Validate node shapes
      for (const node of network.nodes) {
        const n = node as unknown as Record<string, unknown>;
        if (
          typeof n.id !== 'string' ||
          typeof n.inventoryAvailable !== 'number' ||
          typeof n.capacity !== 'number' ||
          typeof n.outflowRate !== 'number'
        ) {
          res.status(400).json({
            error: 'Each node must have: id (string), inventoryAvailable (number), capacity (number), outflowRate (number)',
          });
          return;
        }
        if ((n.inventoryAvailable as number) < 0 || (n.capacity as number) < 0) {
          res.status(400).json({ error: `Node ${n.id as string}: inventoryAvailable and capacity must be non-negative` });
          return;
        }
      }

      // Validate edge shapes
      for (const edge of network.edges) {
        const e = edge as unknown as Record<string, unknown>;
        if (
          typeof e.from !== 'string' ||
          typeof e.to !== 'string' ||
          typeof e.costPerTonKm !== 'number' ||
          typeof e.distanceKm !== 'number' ||
          typeof e.maxFlow !== 'number'
        ) {
          res.status(400).json({
            error: 'Each edge must have: from (string), to (string), costPerTonKm (number), distanceKm (number), maxFlow (number)',
          });
          return;
        }
        if ((e.costPerTonKm as number) < 0 || (e.distanceKm as number) < 0 || (e.maxFlow as number) < 0) {
          res.status(400).json({
            error: `Edge ${e.from as string}→${e.to as string}: costPerTonKm, distanceKm, and maxFlow must be non-negative`,
          });
          return;
        }
      }

      const optimizerRequest: OptimizationRequest = {
        network,
        demand: demand as Record<string, number>,
        topK,
      };

      const result = optimizeReallocation(optimizerRequest);
      res.status(200).json(result);
    } catch (err) {
      console.error('[optimizer] rebalance error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
