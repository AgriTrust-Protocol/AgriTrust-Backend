import { Router, Request, Response } from 'express';
import { Scheduler } from '../../job-queue/scheduler';
import { JobQueuePersistence } from '../../job-queue/persistence';
import { WorkerPool } from '../../job-queue/worker-pool';
import { DEFAULT_DLQ_LIST_LIMIT, Priority } from '../../job-queue/types';

export function createAdminJobsRouter(
  scheduler: Scheduler,
  persistence: JobQueuePersistence,
  workerPool: WorkerPool,
): Router {
  const router = Router();

  /**
   * GET /admin/jobs/queue
   * Full snapshot of the job queue: pending by priority, active jobs,
   * and worker utilisation.
   */
  router.get('/jobs/queue', async (_req: Request, res: Response) => {
    try {
      const byPriority: Record<string, unknown> = {};
      for (const p of [1, 2, 3, 4, 5]) {
        byPriority[String(p)] = await persistence.peekAll(p as Priority, 100);
      }

      const active = workerPool.listActive();
      const workerUtilisation = workerPool.getActiveByType();
      const totalDepth = await persistence.totalDepth();
      const deadLetterDepth = await persistence.deadLetterDepth();
      const deficits = scheduler.getDeficits();

      res.status(200).json({
        byPriority,
        active,
        workerUtilisation,
        totalDepth,
        deadLetterDepth,
        deficits,
        workerPoolSize: workerPool.capacity,
        activeCount: workerPool.activeCount,
        schedulerRunning: scheduler.isRunning(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Admin] GET /jobs/queue error:`, msg);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /** GET /admin/jobs/dead-letter — inspect terminally failed jobs. */
  router.get('/jobs/dead-letter', async (req: Request, res: Response) => {
    try {
      const rawLimit = Number(req.query.limit ?? DEFAULT_DLQ_LIST_LIMIT);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : DEFAULT_DLQ_LIST_LIMIT;
      const jobs = await persistence.listDeadLetters(limit);
      const totalDepth = await persistence.deadLetterDepth();
      res.status(200).json({ jobs, totalDepth, limit });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Admin] GET /jobs/dead-letter error:`, msg);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /** POST /admin/jobs/dead-letter/:id/replay — move a DLQ job back to live processing. */
  router.post('/jobs/dead-letter/:id/replay', async (req: Request, res: Response) => {
    try {
      const jobId = req.params.id as string;
      const replayed = await persistence.replayDeadLetter(jobId);
      if (!replayed) {
        res.status(404).json({ error: `Dead-letter job ${jobId} not found` });
        return;
      }

      res.status(202).json({ message: `Dead-letter job ${jobId} replayed`, job: replayed });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Admin] POST /jobs/dead-letter/:id/replay error:`, msg);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /** DELETE /admin/jobs/dead-letter/:id — purge a reviewed DLQ job. */
  router.delete('/jobs/dead-letter/:id', async (req: Request, res: Response) => {
    try {
      const jobId = req.params.id as string;
      const purged = await persistence.purgeDeadLetter(jobId);
      if (!purged) {
        res.status(404).json({ error: `Dead-letter job ${jobId} not found` });
        return;
      }

      res.status(200).json({ message: `Dead-letter job ${jobId} purged`, jobId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Admin] DELETE /jobs/dead-letter/:id error:`, msg);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /admin/jobs/rebalance
   * Force-reset the deficit counters — useful after a burst of
   * high-priority jobs saturates the pool.
   */
  router.post('/jobs/rebalance', (_req: Request, res: Response) => {
    try {
      scheduler.rebalance();
      res.status(200).json({
        message: 'Deficit counters reset',
        deficits: scheduler.getDeficits(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Admin] POST /jobs/rebalance error:`, msg);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /admin/jobs/cancel/:id
   * Cancel a pending job by id.
   */
  router.post('/jobs/cancel/:id', async (req: Request, res: Response) => {
    try {
      const jobId = req.params.id as string;
      const removed = await persistence.remove(jobId);
      if (removed) {
        res.status(200).json({ message: `Job ${jobId} cancelled`, jobId });
      } else {
        res.status(404).json({ error: `Job ${jobId} not found` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Admin] POST /jobs/cancel error:`, msg);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /** POST /admin/jobs/workers/resize — adjust worker pool size dynamically. */
  router.post('/jobs/workers/resize', (req: Request, res: Response) => {
    try {
      const newSize = typeof req.body?.size === 'number' ? req.body.size : null;
      if (newSize == null || newSize < 1) {
        res.status(400).json({ error: 'Provide a valid "size" >= 1' });
        return;
      }
      workerPool.resize(newSize);
      res.status(200).json({
        message: `Worker pool resized to ${newSize}`,
        poolSize: workerPool.capacity,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Admin] POST /jobs/workers/resize error:`, msg);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
