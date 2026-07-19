import { Router, Request, Response } from 'express';
import { MerkleMountainRange, MmrProof } from './mmr';
import { ProvenanceEventLog } from './event_log';

export function verifyInclusion(proof: MmrProof, root: string | Buffer): boolean {
  return MerkleMountainRange.verifyProof(proof, root);
}

export function createProvenanceRouter(eventLog: ProvenanceEventLog): Router {
  const router = Router();

  router.get('/provenance/:event_id/proof', (req: Request, res: Response) => {
    try {
      const proof = eventLog.proveInclusion(String(req.params.event_id));
      res.json({ proof, root: eventLog.root.toString('hex') });
    } catch (err) {
      res.status(404).json({ error: 'Provenance event not found' });
    }
  });

  router.post('/provenance/proof/verify', (req: Request, res: Response) => {
    try {
      res.json({ valid: verifyInclusion(req.body.proof, req.body.root) });
    } catch (err) {
      res.status(400).json({ valid: false });
    }
  });

  return router;
}
