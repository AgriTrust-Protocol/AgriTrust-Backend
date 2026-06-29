import { TelemetryRecord } from '../types/telemetry';

export const CANONICAL_TELEMETRY_VERSION = 'v3';
export const SUPPORTED_TELEMETRY_VERSIONS = ['v1', 'v2', 'v3'] as const;
export type TelemetrySchemaVersion = (typeof SUPPORTED_TELEMETRY_VERSIONS)[number];

type Json = Record<string, unknown>;
type Migration = (payload: Json) => Json;

function isoTimestamp(value: unknown): string {
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  throw new Error('Telemetry timestamp is missing');
}

export class PayloadMigrator {
  private readonly migrations = new Map<string, Migration>([
    ['v1->v2', this.v1ToV2.bind(this)],
    ['v2->v3', this.v2ToV3.bind(this)],
  ]);

  migrate(payload: Json, fromVersion: string, toVersion = CANONICAL_TELEMETRY_VERSION): TelemetryRecord {
    if (fromVersion === toVersion) return this.toCanonical(payload);
    let current = payload;
    let version = fromVersion;
    const guard = SUPPORTED_TELEMETRY_VERSIONS.length;
    for (let i = 0; version !== toVersion && i < guard; i += 1) {
      const next = this.nextVersion(version, toVersion);
      const migration = this.migrations.get(`${version}->${next}`);
      if (!migration) throw new Error(`No telemetry migration path from ${version} to ${toVersion}`);
      current = migration(current);
      version = next;
    }
    if (version !== toVersion) throw new Error(`No telemetry migration path from ${fromVersion} to ${toVersion}`);
    return this.toCanonical(current);
  }

  v1ToV2(payload: Json): Json {
    const gps = typeof payload.lat === 'number' && typeof payload.lon === 'number' ? { lat: payload.lat, lon: payload.lon } : undefined;
    return {
      schema_version: 'v2',
      deviceId: payload.device_id,
      timestamp: isoTimestamp(payload.ts),
      temperature: payload.temp_c,
      humidity: payload.hum_pct,
      shock: payload.shock_g,
      gps,
      metadata: { source_schema_version: 'v1' },
    };
  }

  v2ToV3(payload: Json): Json {
    return {
      schema_version: 'v3',
      deviceId: payload.deviceId,
      timestamp: isoTimestamp(payload.timestamp),
      temperature: payload.temperature,
      humidity: payload.humidity,
      shock: payload.shock,
      gps: payload.gps,
      metadata: { ...(payload.metadata as Json | undefined), source_schema_version: payload.schema_version ?? 'v2' },
    };
  }

  private nextVersion(current: string, target: string): string {
    const currentIndex = SUPPORTED_TELEMETRY_VERSIONS.indexOf(current as TelemetrySchemaVersion);
    const targetIndex = SUPPORTED_TELEMETRY_VERSIONS.indexOf(target as TelemetrySchemaVersion);
    if (currentIndex === -1 || targetIndex === -1 || currentIndex > targetIndex) {
      throw new Error(`Unsupported telemetry migration ${current}->${target}`);
    }
    return SUPPORTED_TELEMETRY_VERSIONS[currentIndex + 1];
  }

  private toCanonical(payload: Json): TelemetryRecord {
    if (typeof payload.deviceId !== 'string' || typeof payload.temperature !== 'number') {
      throw new Error('Canonical telemetry payload is missing required fields');
    }
    return {
      deviceId: payload.deviceId,
      timestamp: isoTimestamp(payload.timestamp),
      temperature: payload.temperature,
      humidity: typeof payload.humidity === 'number' ? payload.humidity : undefined,
      shock: typeof payload.shock === 'number' ? payload.shock : undefined,
      gps: payload.gps as TelemetryRecord['gps'],
      metadata: (payload.metadata as Record<string, unknown> | undefined) ?? {},
    };
  }
}
