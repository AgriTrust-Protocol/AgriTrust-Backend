import { Priority, ResourceBudget } from '../job-queue/types';

/** Default per-job-type resource budgets and handler metadata. */
export interface JobTypeConfig {
  priority: Priority;
  maxConcurrency: number;
  resourceBudget: ResourceBudget;
}

/**
 * Every job type known to the registry. Add new types here — the
 * scheduler will honour these budgets automatically.
 */
export const DEFAULT_JOB_CONFIGS: Record<string, JobTypeConfig> = {
  certificate_minting: {
    priority: Priority.Critical,
    maxConcurrency: 5,
    resourceBudget: {
      maxConcurrency: 5,
      timeoutMs: 300_000,
      retryLimit: 2,
    },
  },
  attestation_sync: {
    priority: Priority.High,
    maxConcurrency: 10,
    resourceBudget: {
      maxConcurrency: 10,
      timeoutMs: 300_000,
      retryLimit: 2,
    },
  },
  provenance_recalculation: {
    priority: Priority.Normal,
    maxConcurrency: 2,
    resourceBudget: {
      maxConcurrency: 2,
      timeoutMs: 300_000,
      retryLimit: 2,
    },
  },
  event_cold_storage: {
    priority: Priority.Low,
    maxConcurrency: 3,
    resourceBudget: {
      maxConcurrency: 3,
      timeoutMs: 300_000,
      retryLimit: 2,
    },
  },
  device_revocation: {
    priority: Priority.High,
    maxConcurrency: 5,
    resourceBudget: {
      maxConcurrency: 5,
      timeoutMs: 300_000,
      retryLimit: 2,
    },
  },
  inventory_deposit: {
    priority: Priority.Normal,
    maxConcurrency: 3,
    resourceBudget: {
      maxConcurrency: 3,
      timeoutMs: 300_000,
      retryLimit: 2,
    },
  },
  key_retirement: {
    priority: Priority.Low,
    maxConcurrency: 1,
    resourceBudget: {
      maxConcurrency: 1,
      timeoutMs: 60_000,
      retryLimit: 3,
    },
  },
};