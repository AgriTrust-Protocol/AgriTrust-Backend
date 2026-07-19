import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { describe, expect, it } from 'vitest';
import { RawTelemetryWriter, RawSensorPayload } from '../../src/ingestion/raw_writer';
import { SchemaOnReadQueryRouter } from '../../src/ingestion/query_router';
import { SensorTelemetryStreamProcessor, ThresholdAlert } from '../../src/ingestion/stream_processor';
import { WasmSchemaRegistry } from '../../src/ingestion/schema_registry';

function jsonParser(payload: Buffer, metadata: { timestamp: Date }) {
  const parsed = JSON.parse(payload.toString('utf8'));
  return { ...parsed, ts: metadata.timestamp };
}

describe('IoT schema-on-read telemetry ingestion', () => {
  it('registers 3 parsers, ingests 10K mixed payloads, queries by farm_id, and emits stream alerts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iot-raw-'));
    const registry = new WasmSchemaRegistry();
    for (const type of ['soil-v1', 'climate-v2', 'npk-v1']) {
      registry.registerParser({ sensorType: type, wasmModule: Buffer.from(`wasm:${type}`), parser: jsonParser });
    }

    const writer = new RawTelemetryWriter(root);
    const base = new Date('2026-07-19T10:00:00.000Z');
    const sensorTypes = ['soil-v1', 'climate-v2', 'npk-v1'];
    const batch: RawSensorPayload[] = Array.from({ length: 10_000 }, (_, i) => ({
      sensorType: sensorTypes[i % sensorTypes.length],
      timestamp: new Date(base.getTime() + i * 1000),
      binaryPayload: Buffer.from(JSON.stringify({
        sensorId: `sensor-${i % 300}`,
        farmId: i % 2 === 0 ? 'farm-a' : 'farm-b',
        moisture: i % 50,
        temperature: 18 + (i % 20),
        humidity: 40 + (i % 40),
        ph: 6 + ((i % 20) / 10),
      })),
    }));
    await writer.appendBatch(batch);

    const router = new SchemaOnReadQueryRouter(root, registry);
    const avg = await router.avg('moisture', { farmId: 'farm-a', since: new Date('2026-07-19T09:00:00.000Z') });
    expect(avg).toBe(24);

    const processor = new SensorTelemetryStreamProcessor(registry, 20);
    const alerts: ThresholdAlert[] = [];
    processor.on('alert', (alert) => alerts.push(alert));
    for (const reading of batch.slice(0, 100)) processor.process(reading);
    expect(alerts.length).toBe(40);
  });
});
