import crypto from 'crypto';

export type ParsedSensorReading = {
  sensorId: string;
  farmId: string;
  ts: Date;
  moisture?: number;
  temperature?: number;
  humidity?: number;
  ph?: number;
  npk?: { nitrogen?: number; phosphorus?: number; potassium?: number };
  [key: string]: unknown;
};

export type SensorParser = (payload: Buffer, metadata: { sensorType: string; timestamp: Date }) => ParsedSensorReading;

export interface ParserRegistration {
  sensorType: string;
  wasmModule: Buffer;
  parser: SensorParser;
  version?: string;
}

export class WasmSchemaRegistry {
  private readonly parsers = new Map<string, { parser: SensorParser; moduleHash: string; version: string }>();

  registerParser(registration: ParserRegistration): string {
    if (!registration.sensorType.trim()) throw new Error('sensorType is required');
    if (registration.wasmModule.length === 0) throw new Error(`WASM parser for ${registration.sensorType} is empty`);
    const moduleHash = crypto.createHash('sha256').update(registration.wasmModule).digest('hex');
    this.parsers.set(registration.sensorType, {
      parser: registration.parser,
      moduleHash,
      version: registration.version ?? moduleHash.slice(0, 12),
    });
    return moduleHash;
  }

  getParser(sensorType: string): SensorParser {
    const entry = this.parsers.get(sensorType);
    if (!entry) throw new Error(`No WASM parser registered for sensor type ${sensorType}`);
    return entry.parser;
  }

  parse(sensorType: string, payload: Buffer, timestamp: Date): ParsedSensorReading {
    return this.getParser(sensorType)(payload, { sensorType, timestamp });
  }

  metadata(sensorType: string): { moduleHash: string; version: string } | undefined {
    const entry = this.parsers.get(sensorType);
    return entry ? { moduleHash: entry.moduleHash, version: entry.version } : undefined;
  }

  get size(): number { return this.parsers.size; }
}
