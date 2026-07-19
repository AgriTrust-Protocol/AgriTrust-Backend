import fs from 'fs/promises';
import path from 'path';
import { ParsedSensorReading, WasmSchemaRegistry } from './schema_registry';

export interface SensorQuery {
  farmId?: string;
  sensorTypes?: string[];
  since?: Date;
  until?: Date;
  metric?: keyof ParsedSensorReading;
  aggregate?: 'avg';
}

interface RawParquetLine { sensor_type: string; ts: string; payload_b64: string; }

export class SchemaOnReadQueryRouter {
  constructor(private readonly rootDir: string, private readonly registry: WasmSchemaRegistry) {}

  async query(query: SensorQuery): Promise<ParsedSensorReading[]> {
    const files = await this.discoverFiles(query.sensorTypes);
    const results: ParsedSensorReading[] = [];
    for (const file of files) {
      const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const raw = JSON.parse(line) as RawParquetLine;
        const ts = new Date(raw.ts);
        if (query.since && ts <= query.since) continue;
        if (query.until && ts > query.until) continue;
        const parsed = this.registry.parse(raw.sensor_type, Buffer.from(raw.payload_b64, 'base64'), ts);
        if (query.farmId && parsed.farmId !== query.farmId) continue;
        results.push(parsed);
      }
    }
    return results;
  }

  async avg(metric: keyof ParsedSensorReading, query: Omit<SensorQuery, 'metric' | 'aggregate'>): Promise<number | null> {
    const rows = await this.query({ ...query, metric, aggregate: 'avg' });
    const values = rows.map((row) => row[metric]).filter((value): value is number => typeof value === 'number');
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private async discoverFiles(sensorTypes?: string[]): Promise<string[]> {
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      let entries: import('fs').Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.parquet')) files.push(full);
      }
    }
    const roots = sensorTypes?.length ? sensorTypes.map((type) => path.join(this.rootDir, `sensor_type=${encodeURIComponent(type)}`)) : [this.rootDir];
    for (const root of roots) await walk(root);
    return files.sort();
  }
}
