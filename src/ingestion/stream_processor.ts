import { EventEmitter } from 'events';
import { RawSensorPayload } from './raw_writer';
import { ParsedSensorReading, WasmSchemaRegistry } from './schema_registry';

export interface ThresholdAlert {
  sensorId: string;
  farmId: string;
  sensorType: string;
  metric: 'moisture';
  value: number;
  threshold: number;
  ts: Date;
}

export class SensorTelemetryStreamProcessor extends EventEmitter {
  constructor(private readonly registry: WasmSchemaRegistry, private readonly moistureThreshold = 20) { super(); }

  process(reading: RawSensorPayload): ParsedSensorReading {
    const parsed = this.registry.parse(reading.sensorType, reading.binaryPayload, reading.timestamp);
    if (typeof parsed.moisture === 'number' && parsed.moisture < this.moistureThreshold) {
      this.emit('alert', {
        sensorId: parsed.sensorId,
        farmId: parsed.farmId,
        sensorType: reading.sensorType,
        metric: 'moisture',
        value: parsed.moisture,
        threshold: this.moistureThreshold,
        ts: parsed.ts,
      } satisfies ThresholdAlert);
    }
    return parsed;
  }
}
