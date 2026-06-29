import { EventEmitter } from 'events';
import { describe, expect, it, beforeEach } from 'vitest';
import { metricsRegistry } from '../../src/api/metrics/registry';
import { PayloadMigrator } from '../../src/ingestion/payload-migrator';
import { SchemaRegistry } from '../../src/ingestion/schema-registry';
import { InMemoryRedisList, TelemetryQuarantine } from '../../src/ingestion/quarantine';
import { TelemetryGateway } from '../../src/ingestion/telemetry-gateway';

class MockMqttClient extends EventEmitter {
  subscribedTopic?: string;
  subscribe(topic: string): void {
    this.subscribedTopic = topic;
  }
  publish(topic: string, payload: Buffer, packet?: { properties?: { userProperties?: Record<string, string> } }): void {
    this.emit('message', topic, payload, packet);
  }
}

function buildGateway() {
  const registry = new SchemaRegistry();
  registry.loadFromDirectory();
  const redis = new InMemoryRedisList();
  const gateway = new TelemetryGateway({
    mqttClient: new MockMqttClient(),
    registry,
    migrator: new PayloadMigrator(),
    quarantine: new TelemetryQuarantine(redis),
  });
  return { gateway, redis, registry };
}

describe('TelemetryGateway', () => {
  beforeEach(() => {
    metricsRegistry.resetMetrics();
  });

  it('migrates legacy v1 telemetry to the canonical record', async () => {
    const { gateway } = buildGateway();
    const record = await gateway.handleMessage('reefer-1/telemetry', Buffer.from(JSON.stringify({
      schema_version: 'v1',
      device_id: 'reefer-1',
      ts: '2026-06-26T00:00:00.000Z',
      temp_c: 2.5,
      hum_pct: 77,
      shock_g: 0.2,
      lat: 6.45,
      lon: 3.39,
    })));

    expect(record).toMatchObject({
      deviceId: 'reefer-1',
      timestamp: '2026-06-26T00:00:00.000Z',
      temperature: 2.5,
      humidity: 77,
      shock: 0.2,
      gps: { lat: 6.45, lon: 3.39 },
    });
    expect(record?.metadata.source_schema_version).toBe('v2');
  });

  it('honors x-schema-version MQTT user properties over payload fields', async () => {
    const { gateway } = buildGateway();
    const payload = Buffer.from(JSON.stringify({
      schema_version: 'ignored',
      deviceId: 'tracker-2',
      timestamp: '2026-06-26T01:00:00.000Z',
      temperature: -4,
      metadata: { firmware: '2.0.0' },
    }));

    const record = await gateway.handleMessage('tracker-2/telemetry', payload, {
      properties: { userProperties: { 'x-schema-version': 'v2' } },
    });

    expect(record?.deviceId).toBe('tracker-2');
    expect(record?.metadata.firmware).toBe('2.0.0');
  });

  it('quarantines unknown schema versions with an unknown tag', async () => {
    const { gateway, redis } = buildGateway();
    const record = await gateway.handleMessage('bad/telemetry', Buffer.from(JSON.stringify({ deviceId: 'bad' })));

    expect(record).toBeUndefined();
    expect(redis.values).toHaveLength(1);
    const entry = JSON.parse(redis.values[0]) as { schema_version: string; error: string };
    expect(entry.schema_version).toBe('unknown');
    expect(entry.error).toContain('Unknown schema version');
  });

  it('rejects decoded payloads larger than 64 KB', async () => {
    const { gateway, redis } = buildGateway();
    const oversized = Buffer.from('x'.repeat((64 * 1024) + 1)).toString('base64');
    const record = await gateway.handleMessage('large/telemetry', Buffer.from(oversized));

    expect(record).toBeUndefined();
    expect(JSON.parse(redis.values[0]).error).toContain('65536 byte decoded limit');
  });
});
