import { Router, Request, Response } from 'express';
import { MintService } from '../../certificate/mintService';

export function createBatchRouter(mintService: MintService): Router {
  const router = Router();

  /**
   * POST /api/v1/batches/:id/certify
   * Triggered by user to certify a batch and mint a certificate.
   */
  router.post('/:id/certify', async (req: Request, res: Response) => {
    const batchId = req.params.id as string;
    const metadata = req.body.metadata || { source: 'api_trigger' };

    try {
      const result = await mintService.mintCertificate(batchId, metadata);

      if (result.success) {
        res.status(200).json({
          message: 'Certificate minted successfully',
          certificate_id: result.certificateId
        });
      } else {
        res.status(409).json({
          error: result.error || 'Minting failed or already in progress'
        });
      }
    } catch (err) {
      console.error(`API Error certifying batch ${batchId}:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}