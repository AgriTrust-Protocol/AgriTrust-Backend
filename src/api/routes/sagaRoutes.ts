import { Router, Request, Response } from 'express';
import { SagaCoordinator } from '../../settlement/saga-coordinator';
import { SagaLogStore } from '../../database/saga_log';

/**
 * Admin/debug routes for the saga orchestration coordinator.
 *
 * GET  /admin/sagas/:id        — inspect a saga's status and full step log
 * POST /admin/sagas/:id/retry  — manually retry a failed saga
 */
export function createSagaRouter(coordinator: SagaCoordinator, logStore: SagaLogStore): Router {
  const router = Router();

  router.get('/:id', async (req: Request, res: Response) => {
    const sagaId = req.params.id as string;
    try {
      const view = await logStore.getSaga(sagaId);
      if (!view.execution) {
        res.status(404).json({ error: `Saga ${sagaId} not found` });
        return;
      }
      res.status(200).json(view);
    } catch (err) {
      console.error(`Failed to load saga ${sagaId}:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/:id/retry', async (req: Request, res: Response) => {
    const sagaId = req.params.id as string;
    try {
      const view = await logStore.getSaga(sagaId);
      const originalParams = (view.execution as any)?.payload;

      if (originalParams && originalParams.variantName) {
        console.log(
          `[Canary Tracker] Retrying saga ${sagaId} under original experiment variant context: ${originalParams.variantName}`,
        );
      }

      const result = await coordinator.retry(sagaId);
      res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message) || /No registered definition/i.test(message)) {
        res.status(404).json({ error: message });
        return;
      }
      if (/Concurrent saga limit/i.test(message)) {
        res.status(429).json({ error: message });
        return;
      }
      console.error(`Failed to retry saga ${sagaId}:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
