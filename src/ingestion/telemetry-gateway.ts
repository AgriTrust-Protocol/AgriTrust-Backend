import { EventEmitter } from 'events';
import { Counter } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';
import { TelemetryRecord } from '../types/telemetry';
import { CANONICAL_TELEMETRY_VERSION, PayloadMigrator } from './payload-migrator';
import { SchemaRegistry } from './schema-registry';
import { TelemetryQuarantine } from './quarantine';

const MAX_DECODED_PAYLOAD_BYTES = 64 * 1024;

export const telemetryIngestedTotal = new Counter({
  name: 'telemetry_ingested_total',
  help: 'Incoming telemetry payloads by ingestion outcome and schema migration path',
  labelNames: ['status', 'from_version', 'to_version'] as const,
  registers: [metricsRegistry],
});

interface MqttLikeClient {
  subscribe(topic: string): unknown;
  on(event: 'message', listener: (topic: string, payload: Buffer, packet?: { properties?: { userProperties?: Record<string, string | string[]> } }) => void): unknown;
}

export interface TelemetryGatewayOptions {
  mqttClient: MqttLikeClient;
  registry: SchemaRegistry;
  migrator: PayloadMigrator;
  quarantine: TelemetryQuarantine;
  eventBus?: EventEmitter;
  topic?: string;
}

export class TelemetryGateway {
  readonly eventBus: EventEmitter;
  private readonly topic: string;

  constructor(private readonly options: TelemetryGatewayOptions) {
    this.eventBus = options.eventBus ?? new EventEmitter();
    this.topic = options.topic ?? '+/telemetry';
  }

  start(): void {
    this.options.mqttClient.subscribe(this.topic);
    this.options.mqttClient.on('message', (topic, payload, packet) => {
      void this.handleMessage(topic, payload, packet);
    });
  }

  async handleMessage(topic: string, payload: Buffer, packet?: { properties?: { userProperties?: Record<string, string | string[]> } }): Promise<TelemetryRecord | undefined> {
    let parsed: Record<string, unknown> | undefined;
    let fromVersion = 'unknown';
    try {
      const decoded = this.decodePayload(payload);
      parsed = JSON.parse(decoded) as Record<string, unknown>;
      fromVersion = this.resolveSchemaVersion(parsed, packet);
      const registered = this.options.registry.resolve(fromVersion);
      if (!registered) throw new Error(`Unknown schema version: ${fromVersion}`);
      const versionedPayload = { ...parsed, schema_version: fromVersion };
      this.options.registry.validate(fromVersion, versionedPayload);
      const canonical = this.options.migrator.migrate(versionedPayload, fromVersion, CANONICAL_TELEMETRY_VERSION);
      this.options.registry.validate(CANONICAL_TELEMETRY_VERSION, { schema_version: CANONICAL_TELEMETRY_VERSION, ...canonical });
      telemetryIngestedTotal.inc({ status: fromVersion === CANONICAL_TELEMETRY_VERSION ? 'ok' : 'migrated', from_version: fromVersion, to_version: CANONICAL_TELEMETRY_VERSION });
      this.eventBus.emit('telemetry', canonical);
      return canonical;
    } catch (error) {
      await this.options.quarantine.write({
        topic,
        payload: payload.toString('utf8'),
        schema_version: fromVersion === 'unknown' ? 'unknown' : fromVersion,
        error: error instanceof Error ? error.message : String(error),
      });
      telemetryIngestedTotal.inc({ status: 'quarantined', from_version: fromVersion, to_version: CANONICAL_TELEMETRY_VERSION });
      return undefined;
    }
  }

  private resolveSchemaVersion(payload: Record<string, unknown>, packet?: { properties?: { userProperties?: Record<string, string | string[]> } }): string {
    const property = packet?.properties?.userProperties?.['x-schema-version'];
    const version = Array.isArray(property) ? property[0] : property;
    if (typeof version === 'string' && version.length > 0) return version;
    if (typeof payload.schema_version === 'string' && payload.schema_version.length > 0) return payload.schema_version;
    return 'unknown';
  }

  private decodePayload(payload: Buffer): string {
    const raw = payload.toString('utf8');
    const decoded = /^[A-Za-z0-9+/=\r\n]+$/.test(raw.trim()) ? Buffer.from(raw, 'base64') : payload;
    if (decoded.byteLength > MAX_DECODED_PAYLOAD_BYTES) {
      throw new Error(`Telemetry payload exceeds ${MAX_DECODED_PAYLOAD_BYTES} byte decoded limit`);
    }
    return decoded.toString('utf8');
  }
}
