export { configLoader, ConfigLoader } from './loader';
export { configSchema, type AppConfig, redactSensitiveValues, SENSITIVE_KEYS } from './schema';
export { createConfigRouter } from './config-api';
export {
  collectConfigMetrics,
  recordValidationError,
  resetConfigMetrics,
} from './config-monitoring';

import { configLoader } from './loader';
import { collectConfigMetrics } from './config-monitoring';

try {
  configLoader.loadDotEnv();
} catch (err) {
  console.error('[config] Failed to load configuration:', err);
  process.exit(1);
}

collectConfigMetrics();

export const config = configLoader.config;
