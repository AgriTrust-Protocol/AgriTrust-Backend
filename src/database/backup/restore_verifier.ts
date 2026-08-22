import { randomUUID } from 'crypto';
import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../../api/metrics/registry';

export type BackupVerificationStatus = 'passed' | 'failed';

export interface BackupCandidate {
  id: string;
  location: string;
  takenAt: Date;
  checksum?: string;
  sizeBytes?: number;
}

export interface BackupCatalog {
  getLatestBackup(): Promise<BackupCandidate | null>;
}

export interface RestoreSandbox {
  restore(backup: BackupCandidate, databaseName: string): Promise<void>;
  query<T = unknown>(databaseName: string, sql: string): Promise<T[]>;
  destroy(databaseName: string): Promise<void>;
}

export interface BackupVerificationCheck {
  name: string;
  sql: string;
  minRows?: number;
}

export interface BackupVerificationResult {
  id: string;
  backupId?: string;
  status: BackupVerificationStatus;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  sandboxDatabase: string;
  error?: string;
  checks: Array<{ name: string; rows: number; passed: boolean }>;
}

export interface BackupVerificationOptions {
  catalog: BackupCatalog;
  sandbox: RestoreSandbox;
  checks: BackupVerificationCheck[];
  now?: () => Date;
  sandboxDatabasePrefix?: string;
}

const duration = new Histogram({
  name: 'database_backup_verification_duration_ms',
  help: 'Duration of scheduled database backup restore verification runs in milliseconds',
  labelNames: ['status'] as const,
  buckets: [50, 100, 250, 500, 1000, 5000, 30000, 300000, 900000],
  registers: [metricsRegistry],
});

const results = new Counter({
  name: 'database_backup_verification_total',
  help: 'Total scheduled database backup restore verification runs by status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const lastSuccess = new Gauge({
  name: 'database_backup_last_success_timestamp_seconds',
  help: 'Unix timestamp of the most recent successful database backup restore verification',
  registers: [metricsRegistry],
});

const lastAge = new Gauge({
  name: 'database_backup_latest_age_seconds',
  help: 'Age of the latest database backup selected for restore verification',
  registers: [metricsRegistry],
});

export const backupVerificationMetrics = {
  duration,
  results,
  lastSuccess,
  lastAge,
};

export const DEFAULT_BACKUP_VERIFICATION_CHECKS: BackupVerificationCheck[] = [
  {
    name: 'migrations_present',
    sql: 'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    minRows: 1,
  },
  { name: 'certificates_table_readable', sql: 'SELECT id FROM certificates LIMIT 1', minRows: 0 },
  { name: 'devices_table_readable', sql: 'SELECT id FROM devices LIMIT 1', minRows: 0 },
];

export class BackupRestoreVerifier {
  private readonly catalog: BackupCatalog;
  private readonly sandbox: RestoreSandbox;
  private readonly checks: BackupVerificationCheck[];
  private readonly now: () => Date;
  private readonly sandboxDatabasePrefix: string;

  constructor(options: BackupVerificationOptions) {
    this.catalog = options.catalog;
    this.sandbox = options.sandbox;
    this.checks = options.checks;
    this.now = options.now ?? (() => new Date());
    this.sandboxDatabasePrefix = options.sandboxDatabasePrefix ?? 'backup_verify';
  }

  async verifyLatest(): Promise<BackupVerificationResult> {
    const startedAt = this.now();
    const sandboxDatabase = `${this.sandboxDatabasePrefix}_${randomUUID().replace(/-/g, '')}`;
    const checkResults: BackupVerificationResult['checks'] = [];
    let backup: BackupCandidate | null = null;

    try {
      backup = await this.catalog.getLatestBackup();
      if (!backup) {
        throw new Error('No database backup candidate available for verification');
      }

      lastAge.set(Math.max(0, (startedAt.getTime() - backup.takenAt.getTime()) / 1000));
      await this.sandbox.restore(backup, sandboxDatabase);

      for (const check of this.checks) {
        const rows = await this.sandbox.query(sandboxDatabase, check.sql);
        const rowCount = rows.length;
        const passed = rowCount >= (check.minRows ?? 1);
        checkResults.push({ name: check.name, rows: rowCount, passed });
        if (!passed) {
          throw new Error(`Backup verification check failed: ${check.name}`);
        }
      }

      return this.finish('passed', startedAt, sandboxDatabase, checkResults, backup.id);
    } catch (error) {
      return this.finish(
        'failed',
        startedAt,
        sandboxDatabase,
        checkResults,
        backup?.id,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await this.sandbox.destroy(sandboxDatabase);
    }
  }

  private finish(
    status: BackupVerificationStatus,
    startedAt: Date,
    sandboxDatabase: string,
    checks: BackupVerificationResult['checks'],
    backupId?: string,
    error?: string,
  ): BackupVerificationResult {
    const completedAt = this.now();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    duration.observe({ status }, durationMs);
    results.inc({ status });
    if (status === 'passed') {
      lastSuccess.set(completedAt.getTime() / 1000);
    }

    return {
      id: randomUUID(),
      backupId,
      status,
      startedAt,
      completedAt,
      durationMs,
      sandboxDatabase,
      error,
      checks,
    };
  }
}
