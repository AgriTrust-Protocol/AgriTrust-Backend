import { Gauge, Counter } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';
import { configLoader } from './loader';

export const configVersionGauge = new Gauge({
  name: 'agritrust_config_version',
  help: 'Current configuration version (incremented on each reload)',
  registers: [metricsRegistry],
});

export const configReloadsTotal = new Counter({
  name: 'agritrust_config_reloads_total',
  help: 'Total number of configuration reloads',
  registers: [metricsRegistry],
});

export const configLastReloadTimestamp = new Gauge({
  name: 'agritrust_config_last_reload_timestamp_seconds',
  help: 'Unix timestamp of the last successful configuration reload',
  registers: [metricsRegistry],
});

export const configValidationErrorsTotal = new Counter({
  name: 'agritrust_config_validation_errors_total',
  help: 'Total number of configuration validation errors',
  registers: [metricsRegistry],
});

export const configFrozenGauge = new Gauge({
  name: 'agritrust_config_frozen',
  help: '1 if configuration is frozen (read-only), 0 otherwise',
  registers: [metricsRegistry],
});

let lastReloadCount = 0;

export function collectConfigMetrics(): void {
  const history = configLoader.getHistory();
  if (history.length > 0) {
    const lastEntry = history[history.length - 1];
    configLastReloadTimestamp.set(lastEntry.timestamp / 1000);
  }
  configVersionGauge.set(history.length);
  configFrozenGauge.set(configLoader.isFrozen ? 1 : 0);

  const currentReloadCount = history.length;
  const reloadDelta = currentReloadCount - lastReloadCount;
  if (reloadDelta > 0) {
    configReloadsTotal.inc(reloadDelta);
    lastReloadCount = currentReloadCount;
  }
}

export function recordValidationError(): void {
  configValidationErrorsTotal.inc();
}

export function resetConfigMetrics(): void {
  configVersionGauge.reset();
  configReloadsTotal.reset();
  configLastReloadTimestamp.reset();
  configValidationErrorsTotal.reset();
  configFrozenGauge.reset();
  lastReloadCount = 0;
}
