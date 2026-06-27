import type { Pool } from 'pg';
import { validateBatchData } from '../validation/batchIntegrity';

export interface SensorReading {
  batchId: string;
  sensorId: string;
  ph: number;
  moisture: number;
  temperature: number;
  timestamp: string;
}

/**
 * Ingest a soil-sensor reading for a batch.
 * Delegates locking and log-append to validateBatchData.
 */
export async function ingestSensorReading(
  pool: Pool,
  reading: SensorReading,
): Promise<{ sourceHash: string }> {
  return validateBatchData(pool, {
    batchId: reading.batchId,
    source: `sensor:${reading.sensorId}`,
    data: {
      sensorId: reading.sensorId,
      ph: reading.ph,
      moisture: reading.moisture,
      temperature: reading.temperature,
      timestamp: reading.timestamp,
    },
  });
}
