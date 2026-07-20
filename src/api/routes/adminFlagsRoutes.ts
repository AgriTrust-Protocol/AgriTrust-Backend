/**
 * Admin Feature Flags Routes
 *
 * GET    /admin/flags           — list all flags
 * POST   /admin/flags/:key      — create or update a flag
 * DELETE /admin/flags/:key      — delete a flag
 *
 * Every mutation is audit-logged to stdout with actor, action, key, and
 * timestamp so the audit trail is available in structured logs.
 */

import { Router, Request, Response } from 'express';
import { FeatureEngine, FlagDefinition } from '../../feature-flags/engine';
import { ConfigStore } from '../../feature-flags/config-store';
import { Propagator, RedisPublishClient } from '../../feature-flags/propagator';

export function createAdminFlagsRouter(
  engine:    FeatureEngine,
  store:     ConfigStore,
  publisher: RedisPublishClient,
): Router {
  const router = Router();

  // ── GET /admin/flags ─────────────────────────────────────────────────

  router.get('/', (_req: Request, res: Response) => {
    try {
      const flags = engine.listFlags();
      res.status(200).json({ flags, count: flags.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AdminFlags] GET / error:', msg);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /admin/flags/:key ─────────────────────────────────────────────

  router.get('/:key', async (req: Request, res: Response) => {
    try {
      const key = String(req.params['key']);
      const flag = engine.getFlag(key);
      if (!flag) {
        res.status(404).json({ error: `Flag "${key}" not found` });
        return;
      }
      res.status(200).json(flag);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AdminFlags] GET /:key error:', msg);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /admin/flags/:key ─────────────────────────────────────────────

  router.post('/:key', async (req: Request, res: Response) => {
    try {
      const key  = String(req.params['key']);
      const body = req.body as Partial<FlagDefinition>;

      const flag: FlagDefinition = {
        key,
        enabled:           body.enabled           !== false,
        rolloutPercentage: typeof body.rolloutPercentage === 'number'
          ? body.rolloutPercentage
          : 100,
        targetingRules:    Array.isArray(body.targetingRules)  ? body.targetingRules  : [],
        payload:           typeof body.payload === 'object' && body.payload !== null
          ? body.payload as Record<string, unknown>
          : {},
        variants:          Array.isArray(body.variants) ? body.variants as string[] : [],
      };

      await store.upsertFlag(flag);
      await Propagator.publish(publisher, { action: 'upsert', flag });

      auditLog('upsert', key, req);
      res.status(200).json({ message: `Flag "${key}" saved`, flag });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AdminFlags] POST /:key error:', msg);
      const status = msg.includes('Invalid') || msg.includes('limit') || msg.includes('exceeds') ? 400 : 500;
      res.status(status).json({ error: msg });
    }
  });

  // ── DELETE /admin/flags/:key ──────────────────────────────────────────

  router.delete('/:key', async (req: Request, res: Response) => {
    try {
      const key     = String(req.params['key']);
      const existed = await store.deleteFlag(key);

      if (!existed) {
        res.status(404).json({ error: `Flag "${key}" not found` });
        return;
      }

      await Propagator.publish(publisher, { action: 'delete', key });

      auditLog('delete', key, req);
      res.status(200).json({ message: `Flag "${key}" deleted`, key });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AdminFlags] DELETE /:key error:', msg);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// ─── Audit logging helper ─────────────────────────────────────────────────

function auditLog(action: string, key: string, req: Request): void {
  const actor = req.header('x-tenant-id') ?? req.ip ?? 'unknown';
  console.log(
    JSON.stringify({
      type:      'feature-flag-audit',
      action,
      flagKey:   key,
      actor,
      timestamp: new Date().toISOString(),
    }),
  );
}
