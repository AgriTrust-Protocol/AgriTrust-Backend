import { JobDef, JobHandler, Priority, ResourceBudget } from './types';
import { DEFAULT_JOB_CONFIGS, JobTypeConfig } from '../config/jobs';

/**
 * Central registry that maps job type → handler, priority, concurrency limits,
 * and resource budget.  Handlers are registered via `register()` and dispatching
 * is done by the `WorkerPool`.
 */
export class JobRegistry {
  private readonly defs = new Map<string, JobDef>();

  /** Register a handler for a job type. Uses defaults from config/jobs.ts. */
  register(type: string, handler: JobHandler): void {
    const cfg: JobTypeConfig | undefined = DEFAULT_JOB_CONFIGS[type];
    if (!cfg) {
      throw new Error(`Unknown job type "${type}" — add it to src/config/jobs.ts`);
    }

    this.defs.set(type, {
      name: type,
      priority: cfg.priority,
      handler,
      maxConcurrency: cfg.maxConcurrency,
      timeoutMs: cfg.resourceBudget.timeoutMs,
      resourceBudget: { ...cfg.resourceBudget },
    });
  }

  /** Look up a job definition. Returns undefined if not registered. */
  get(type: string): JobDef | undefined {
    return this.defs.get(type);
  }

  /** Remove a job type from the registry. */
  unregister(type: string): boolean {
    return this.defs.delete(type);
  }

  /** Iterate all registered job types. */
  list(): IterableIterator<JobDef> {
    return this.defs.values();
  }

  /** Get priority for a job type (falls back to Normal). */
  getPriority(type: string): Priority {
    return this.defs.get(type)?.priority ?? Priority.Normal;
  }

  /** Get resource budget for a job type. */
  getBudget(type: string): ResourceBudget {
    const def = this.defs.get(type);
    return (
      def?.resourceBudget ?? {
        maxConcurrency: 1,
        timeoutMs: 300_000,
        retryLimit: 2,
      }
    );
  }
}
