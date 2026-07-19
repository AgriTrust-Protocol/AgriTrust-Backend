import { Pool, PoolClient } from 'pg';
import { quoteIdentifier } from './sql_ident';

export interface VacuumTuningOptions {
  tableName?: string;
  scaleFactor?: number;
  threshold?: number;
  analyzeScaleFactor?: number;
  analyzeThreshold?: number;
}

export function vacuumTuningSql(options: VacuumTuningOptions = {}): string {
  const table = quoteIdentifier(options.tableName ?? 'sensor_readings');
  const scaleFactor = options.scaleFactor ?? 0.01;
  const threshold = options.threshold ?? 1000;
  const analyzeScaleFactor = options.analyzeScaleFactor ?? 0.005;
  const analyzeThreshold = options.analyzeThreshold ?? 1000;
  return `ALTER TABLE ${table} SET (
    autovacuum_vacuum_scale_factor = ${scaleFactor},
    autovacuum_vacuum_threshold = ${threshold},
    autovacuum_analyze_scale_factor = ${analyzeScaleFactor},
    autovacuum_analyze_threshold = ${analyzeThreshold}
  )`;
}

export async function applyHighWriteVacuumTuning(client: Pool | PoolClient, options: VacuumTuningOptions = {}): Promise<void> {
  await client.query(vacuumTuningSql(options));
}
