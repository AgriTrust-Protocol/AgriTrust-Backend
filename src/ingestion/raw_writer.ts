import fs from 'fs/promises';
import path from 'path';
import { DEFAULT_RAW_PAYLOAD_COMPRESSION, ZstdCompressionConfig, compressionMetadata } from './compression';

export interface RawSensorPayload {
  sensorType: string;
  binaryPayload: Buffer;
  timestamp: Date;
}

export interface StoredRawSensorPayload extends RawSensorPayload {
  partitionPath: string;
}

export class RawTelemetryWriter {
  constructor(
    private readonly rootDir: string,
    private readonly compression: ZstdCompressionConfig = DEFAULT_RAW_PAYLOAD_COMPRESSION,
  ) {}

  async append(reading: RawSensorPayload): Promise<StoredRawSensorPayload> {
    const partitionPath = this.partitionPath(reading.sensorType, reading.timestamp);
    await fs.mkdir(path.dirname(partitionPath), { recursive: true });
    const record = {
      sensor_type: reading.sensorType,
      ts: reading.timestamp.toISOString(),
      payload_b64: reading.binaryPayload.toString('base64'),
      metadata: compressionMetadata(this.compression),
    };
    await fs.appendFile(partitionPath, `${JSON.stringify(record)}\n`);
    return { ...reading, partitionPath };
  }

  async appendBatch(readings: RawSensorPayload[]): Promise<StoredRawSensorPayload[]> {
    const written: StoredRawSensorPayload[] = [];
    for (const reading of readings) written.push(await this.append(reading));
    return written;
  }

  partitionPath(sensorType: string, timestamp: Date): string {
    const iso = timestamp.toISOString();
    const date = iso.slice(0, 10);
    const hour = iso.slice(11, 13);
    return path.join(this.rootDir, `sensor_type=${encodeURIComponent(sensorType)}`, `date=${date}`, `hour=${hour}`, 'raw.parquet');
  }
}
