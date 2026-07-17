import { Router, Request, Response } from 'express';
import { FarmActivityAuditService } from '../../audit/farmActivityAudit';

export function createAuditRouter(auditService: FarmActivityAuditService): Router {
  const router = Router();

  router.post('/events', async (req: Request, res: Response) => {
    try {
      const event = await auditService.appendEvent({
        farmId: req.body.farm_id,
        activityType: req.body.activity_type,
        actorId: req.body.actor_id,
        location: req.body.location,
        payload: req.body.payload ?? {},
        timestamp: req.body.timestamp ? new Date(req.body.timestamp) : undefined,
      });
      res.status(201).json(serializeEvent(event));
    } catch (err) {
      res.status(500).json({ error: 'Failed to append audit event' });
    }
  });

  router.get('/events', async (req: Request, res: Response) => {
    try {
      const events = await auditService.queryEvents({
        farmId: req.query.farm_id as string | undefined,
        activityType: req.query.activity_type as string | undefined,
        actorId: req.query.actor_id as string | undefined,
        from: req.query.from ? new Date(req.query.from as string) : undefined,
        to: req.query.to ? new Date(req.query.to as string) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ events: events.map(serializeEvent) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to query audit events' });
    }
  });

  router.get('/:event_id/proof', async (req: Request, res: Response) => {
    try {
      res.json(await auditService.generateProof(String(req.params.event_id)));
    } catch (err) {
      res.status(404).json({ error: 'Audit event not found' });
    }
  });

  router.post('/proof/verify', (req: Request, res: Response) => {
    res.json({ valid: auditService.verifyProof(req.body) });
  });

  return router;
}

function serializeEvent(event: any) {
  return {
    event_id: event.eventId,
    farm_id: event.farmId,
    activity_type: event.activityType,
    timestamp: event.timestamp.toISOString(),
    actor_id: event.actorId,
    location: event.location,
    payload: event.payload,
    prev_hash: event.prevHash.toString('hex'),
    hash: event.hash.toString('hex'),
    archived_at: event.archivedAt?.toISOString?.() ?? null,
    cold_storage_key: event.coldStorageKey ?? null,
  };
}
