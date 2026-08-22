import { Pool } from 'pg';

/**
 * Shape of a single environmental log row to be inserted.
 */
export interface EnvironmentalLogRow {
  sensorId: string;
  timestamp: Date;
  soilMoisture: number;
  soilPh: number;
  ambientTemp: number;
  humidity: number;
  solarRadiation: number;
  spatialZoneId: number;
}

/**
 * Batch size for insert operations.
 */
const DEFAULT_BATCH_SIZE = 500;

/**
 * Named prepared statement name for efficient batch inserts.
 */
const INSERT_STMT_NAME = 'batch_insert_env_logs';

/**
 * Base INSERT SQL.
 */
const INSERT_SQL = `
  INSERT INTO environmental_logs
    (sensor_id, timestamp, soil_moisture, soil_ph, ambient_temp, humidity, solar_radiation, spatial_zone_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

/**
 * EnvironmentalLogWriter handles batch-inserting telemetry frames
 * into the TimescaleDB hypertable using pg prepared statements.
 *
 * Uses pg's built-in named prepared statement protocol (Parse/Bind/Execute)
 * for efficient multi-row insertion.
 */
export class EnvironmentalLogWriter {
  private pool: Pool;
  private batchSize: number;
  private pending: EnvironmentalLogRow[] = [];
  private totalInserted = 0;

  constructor(pool: Pool, batchSize: number = DEFAULT_BATCH_SIZE) {
    this.pool = pool;
    this.batchSize = batchSize;
  }

  /**
   * Queue a single row for batch insertion. Automatically flushes
   * when the batch reaches the configured size.
   */
  async writeRow(row: EnvironmentalLogRow): Promise<void> {
    this.pending.push(row);
    if (this.pending.length >= this.batchSize) {
      await this.flush();
    }
  }

  /**
   * Queue multiple rows at once. Automatically flushes when the
   * pending count reaches the configured batch size.
   */
  async writeBatch(rows: EnvironmentalLogRow[]): Promise<void> {
    for (const row of rows) {
      this.pending.push(row);
    }
    if (this.pending.length >= this.batchSize) {
      await this.flush();
    }
  }

  /**
   * Flush all pending rows to the database in a single multi-row INSERT.
   * Uses pg's built-in named prepared statement for efficiency.
   */
  async flush(): Promise<void> {
    if (this.pending.length === 0) return;

    const rows = this.pending.splice(0);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for (const row of rows) {
        await client.query({
          name: INSERT_STMT_NAME,
          text: INSERT_SQL,
          values: [
            row.sensorId,
            row.timestamp,
            row.soilMoisture,
            row.soilPh,
            row.ambientTemp,
            row.humidity,
            row.solarRadiation,
            row.spatialZoneId,
          ],
        });
      }

      await client.query('COMMIT');
      this.totalInserted += rows.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Re-queue the rows on failure so they aren't lost
      this.pending.unshift(...rows);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Flush remaining rows.
   * Call this once before shutting down.
   */
  async close(): Promise<void> {
    await this.flush();
  }

  /** Returns the total number of rows successfully inserted. */
  getTotalInserted(): number {
    return this.totalInserted;
  }

  /** Returns the number of rows currently pending in the batch buffer. */
  getPendingCount(): number {
    return this.pending.length;
  }
}

/**
 * Generate a synthetic EnvironmentalLogRow for testing or seeding.
 */
export function generateSyntheticRow(
  sensorId: string,
  timestamp: Date,
  spatialZoneId: number,
): EnvironmentalLogRow {
  return {
    sensorId,
    timestamp,
    soilMoisture: 10 + Math.random() * 40, // 10–50 %
    soilPh: 5.5 + Math.random() * 3.5, // 5.5–9.0
    ambientTemp: 10 + Math.random() * 30, // 10–40 °C
    humidity: 30 + Math.random() * 60, // 30–90 %
    solarRadiation: 100 + Math.random() * 800, // 100–900 W/m²
    spatialZoneId,
  };
}
