/**
 * Feature Flag Middleware
 *
 * Resolves the EvaluationContext from the incoming request and attaches a
 * `features` helper to `req` so downstream handlers can call:
 *
 *   req.features.isEnabled('settlement.new-logic')
 *   req.features.evaluate('settlement.new-logic')
 *
 * Context resolution order:
 *   tenantId  — x-tenant-id header → req.tenantId → req.ip
 *   region    — x-region header
 *   agentRole — x-agent-role header
 */

import { Request, Response, NextFunction } from 'express';
import { FeatureEngine, EvaluationContext, EvaluationResult } from '../feature-flags/engine';

declare global {
  namespace Express {
    interface Request {
      features: RequestFeatures;
    }
  }
}

export interface RequestFeatures {
  isEnabled(key: string): boolean;
  evaluate(key: string): EvaluationResult;
  context: EvaluationContext;
}

export function createFeatureFlagMiddleware(engine: FeatureEngine) {
  return function featureFlagMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    const tenantId =
      req.header('x-tenant-id')?.trim() ||
      (req as Request & { tenantId?: string }).tenantId ||
      req.ip ||
      'unknown';

    const context: EvaluationContext = {
      tenantId,
      region:    req.header('x-region')?.trim(),
      agentRole: req.header('x-agent-role')?.trim(),
    };

    req.features = {
      context,
      isEnabled: (key: string) => engine.isEnabled(key, context),
      evaluate:  (key: string) => engine.evaluate(key, context),
    };

    next();
  };
}
