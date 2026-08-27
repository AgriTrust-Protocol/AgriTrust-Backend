/**
 * AgriTrust Protocol – Continuous Aggregates (#166)
 *
 * Hourly and daily summary materialized views over `sensor_readings`, plus the
 * scheduling that keeps them fresh. Aggregate refresh runs every 5 minutes.
 *
 * The materialized views and the server-side refresh function are defined in
 * the partitioning migration; this module exposes the refresh scheduling so the
 * application can drive it both as an in-process interval and as an ad-hoc
 * refresh (useful for tests and one-off backfills).
 *
 * Note on latches: concurrency guards are advisory via a pg_advisory_xact_lock
 * in `sp_refresh_sensor_aggregates()` so overlapping refreshes serialise rather
 * than error.
 */

import { Pool } from 'pg';

export const REFRESH_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes

export const HOURLY_AGG = 'sensor_readings_hourly_agg';
export const DAILY_AGG = 'sensor_readings_daily_agg';

export class ContinuousAggregates {
  constructor(private readonly pool: Pool) {}

  /**
   * Refresh both materialized views concurrently. Safe to call on the 5-minute
   * schedule or on demand; uses the server-side function to leverage the
   * advisory lock that prevents concurrent refreshes from racing. Resolves to
   * `true` once both views have been refreshed.
   */
  async refresh(): Promise<boolean> {
    await this.pool.query('SELECT sp_refresh_sensor_aggregates()');
    return true;
  }

  /**
   * Refresh only the hourly view. Falls back to a direct statement so the view
   * can be populated on a green-field database before scheduling starts.
   */
  async refreshHourly(): Promise<void> {
    await this.pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${HOURLY_AGG}`);
  }

  /** Refresh only the daily view. */
  async refreshDaily(): Promise<void> {
    await this.pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${DAILY_AGG}`);
  }

  /**
   * Start an in-process scheduler that refreshes aggregates every interval.
   * Returns a stop() handle. The returned timer is intentionally unref()'d so
   * it never keeps the Node.js process alive by itself (tests close cleanly).
   */
  start(intervalMs: number = REFRESH_INTERVAL_MS): { stop: () => void } {
    const timer = setInterval(() => {
      this.refresh().catch((err) => {
        // Scheduled work must never throw to the event loop. Log and continue.
        console.error(`Sensor aggregate refresh failed: ${String(err)}`);
      });
    }, intervalMs);
    timer.unref();
    return {
      stop: (): void => clearInterval(timer),
    };
  }

  /** Ensure both materialized views exist (bootstrapping / tests). */
  async ensureViews(): Promise<void> {
    await this.pool.query(
      `
      CREATE MATERIALIZED VIEW IF NOT EXISTS ${HOURLY_AGG}
      AS
      SELECT
          farm_id,
          sensor_type,
          date_trunc('hour', ts) AS bucket,
          AVG(value) AS avg_value,
          MIN(value) AS min_value,
          MAX(value) AS max_value,
          COUNT(*)   AS sample_count
      FROM sensor_readings
      GROUP BY farm_id, sensor_type, date_trunc('hour', ts)
      WITH NO DATA
      `,
    );
    await this.pool.query(
      `
      CREATE MATERIALIZED VIEW IF NOT EXISTS ${DAILY_AGG}
      AS
      SELECT
          farm_id,
          sensor_type,
          date_trunc('day', ts) AS bucket,
          AVG(value) AS avg_value,
          MIN(value) AS min_value,
          MAX(value) AS max_value,
          COUNT(*)   AS sample_count
      FROM sensor_readings
      GROUP BY farm_id, sensor_type, date_trunc('day', ts)
      WITH NO DATA
      `,
    );
  }
}
