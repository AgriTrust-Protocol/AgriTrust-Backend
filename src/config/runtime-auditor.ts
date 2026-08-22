import { createHash } from 'crypto';
import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';

export type RuntimeConfigValue = string | number | boolean | null | undefined;
export type RuntimeConfigSnapshot = Record<string, RuntimeConfigValue>;

export interface ConfigDrift {
  key: string;
  expectedHash?: string;
  actualHash?: string;
  severity: 'warning' | 'critical';
}

export interface RuntimeAuditResult {
  service: string;
  checkedAt: string;
  durationMs: number;
  snapshotHash: string;
  drift: ConfigDrift[];
}

export interface RuntimeAuditorOptions {
  service: string;
  snapshot: () => RuntimeConfigSnapshot;
  baseline?: Record<string, string>;
  criticalKeys?: string[];
  redactedKeys?: string[];
  clock?: () => Date;
}

const REDACTED_PATTERN = /(secret|token|password|private|credential|key)/i;

export const runtimeConfigAuditDurationMs = new Histogram({
  name: 'runtime_config_audit_duration_ms',
  help: 'Runtime configuration audit duration in milliseconds',
  labelNames: ['service', 'result'] as const,
  buckets: [1, 5, 10, 25, 50, 75, 100, 250],
  registers: [metricsRegistry],
});

export const runtimeConfigDriftTotal = new Counter({
  name: 'runtime_config_drift_total',
  help: 'Total runtime configuration drift detections',
  labelNames: ['service', 'key', 'severity'] as const,
  registers: [metricsRegistry],
});

export const runtimeConfigLastAuditTimestampSeconds = new Gauge({
  name: 'runtime_config_last_audit_timestamp_seconds',
  help: 'Unix timestamp of the last runtime configuration audit',
  labelNames: ['service'] as const,
  registers: [metricsRegistry],
});

export class RuntimeConfigAuditor {
  private baseline: Record<string, string>;
  private readonly criticalKeys: Set<string>;
  private readonly redactedKeys: Set<string>;
  private readonly clock: () => Date;

  constructor(private readonly options: RuntimeAuditorOptions) {
    this.baseline = options.baseline ? { ...options.baseline } : {};
    this.criticalKeys = new Set(options.criticalKeys ?? []);
    this.redactedKeys = new Set(options.redactedKeys ?? []);
    this.clock = options.clock ?? (() => new Date());
  }

  establishBaseline(snapshot = this.options.snapshot()): Record<string, string> {
    this.baseline = hashSnapshot(snapshot, this.redactedKeys);
    return { ...this.baseline };
  }

  audit(): RuntimeAuditResult {
    const start = process.hrtime.bigint();
    const snapshot = this.options.snapshot();
    const hashed = hashSnapshot(snapshot, this.redactedKeys);
    const drift = detectDrift(this.baseline, hashed, this.criticalKeys);
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const result = drift.some((item) => item.severity === 'critical')
      ? 'critical_drift'
      : drift.length > 0
        ? 'drift'
        : 'ok';

    runtimeConfigAuditDurationMs.observe({ service: this.options.service, result }, durationMs);
    runtimeConfigLastAuditTimestampSeconds.set(
      { service: this.options.service },
      Math.floor(this.clock().getTime() / 1000),
    );
    drift.forEach((item) =>
      runtimeConfigDriftTotal.inc({
        service: this.options.service,
        key: item.key,
        severity: item.severity,
      }),
    );

    return {
      service: this.options.service,
      checkedAt: this.clock().toISOString(),
      durationMs,
      snapshotHash: stableHash(hashed),
      drift,
    };
  }
}

export function hashSnapshot(
  snapshot: RuntimeConfigSnapshot,
  redactedKeys: Set<string> = new Set(),
): Record<string, string> {
  return Object.keys(snapshot)
    .sort()
    .reduce<Record<string, string>>((acc, key) => {
      const value =
        redactedKeys.has(key) || REDACTED_PATTERN.test(key) ? '[REDACTED]' : snapshot[key];
      acc[key] = stableHash({ key, value });
      return acc;
    }, {});
}

export function detectDrift(
  baseline: Record<string, string>,
  actual: Record<string, string>,
  criticalKeys: Set<string> = new Set(),
): ConfigDrift[] {
  const keys = Array.from(new Set([...Object.keys(baseline), ...Object.keys(actual)])).sort();
  return keys.flatMap((key) =>
    baseline[key] === actual[key]
      ? []
      : [
          {
            key,
            expectedHash: baseline[key],
            actualHash: actual[key],
            severity: criticalKeys.has(key) ? 'critical' : 'warning',
          },
        ],
  );
}

function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value, Object.keys(value as object).sort()))
    .digest('hex');
}
