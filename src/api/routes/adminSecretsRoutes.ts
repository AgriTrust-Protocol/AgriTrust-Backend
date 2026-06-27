import { Router, Request, Response } from 'express';
import { LeaseManager } from '../../secrets/lease-manager';

export function createAdminSecretsRouter(leaseManager: LeaseManager): Router {
  const router = Router();

  router.get('/secrets/status', (_req: Request, res: Response) => {
    res.status(200).json({ leases: leaseManager.getStatuses() });
  });

  return router;
}
