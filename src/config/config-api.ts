import { Router, Request, Response } from 'express';
import { configLoader } from './loader';

export function createConfigRouter(): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    try {
      const redacted = configLoader.toJSON();
      res.status(200).json({
        config: redacted,
        frozen: configLoader.isFrozen,
        loaded: true,
      });
    } catch {
      res.status(503).json({ error: 'Configuration not loaded yet' });
    }
  });

  router.get('/schema', (_req: Request, res: Response) => {
    const { configSchema } = require('./schema');
    res.status(200).json(configSchema);
  });

  router.get('/history', (_req: Request, res: Response) => {
    try {
      const history = configLoader.getHistory().map(entry => ({
        timestamp: new Date(entry.timestamp).toISOString(),
        source: entry.source,
      }));
      res.status(200).json({ history });
    } catch {
      res.status(503).json({ error: 'Configuration not loaded yet' });
    }
  });

  router.post('/reload', async (_req: Request, res: Response) => {
    try {
      const diff = configLoader.reload();
      res.status(200).json({
        message: 'Configuration reloaded successfully',
        diff: diff,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: `Reload failed: ${message}` });
    }
  });

  router.post('/validate', (req: Request, res: Response) => {
    const result = configLoader.validateConfigObject(req.body ?? {});
    if (result.valid) {
      res.status(200).json({ valid: true });
    } else {
      res.status(400).json({ valid: false, errors: result.errors });
    }
  });

  router.post('/freeze', (_req: Request, res: Response) => {
    configLoader.freeze();
    res.status(200).json({ message: 'Configuration frozen', frozen: true });
  });

  router.post('/unfreeze', (_req: Request, res: Response) => {
    configLoader.unfreeze();
    res.status(200).json({ message: 'Configuration unfrozen', frozen: false });
  });

  return router;
}
