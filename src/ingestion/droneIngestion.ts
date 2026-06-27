import type { Pool } from 'pg';
import { validateBatchData } from '../validation/batchIntegrity';

export interface DroneImagery {
  batchId: string;
  droneId: string;
  ndvi: number;
  altitude: number;
  coverageArea: number;
  timestamp: string;
}

/**
 * Ingest a drone NDVI imagery record for a batch.
 * Delegates locking and log-append to validateBatchData.
 */
export async function ingestDroneImagery(
  pool: Pool,
  imagery: DroneImagery,
): Promise<{ sourceHash: string }> {
  return validateBatchData(pool, {
    batchId: imagery.batchId,
    source: `drone:${imagery.droneId}`,
    data: {
      droneId: imagery.droneId,
      ndvi: imagery.ndvi,
      altitude: imagery.altitude,
      coverageArea: imagery.coverageArea,
      timestamp: imagery.timestamp,
    },
  });
}
