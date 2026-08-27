/**
 * AgriTrust Protocol – Time-Series Optimization Layer (#166)
 *
 * Orchestrates the pure-PostgreSQL time-series storage optimisations for
 * `sensor_readings`:
 *
 *   1. Index strategy   – per-partition BRIN + partial GIN access paths.
 *   2. Continuous aggs  – hourly/daily materialized views, fresh every 5 min.
 *   3. Partition sweep  – detach partitions past the 90-day rolling window.
 *   4. Compression      – columnar conversion for partitions older than 7 days.
 *   5. Vacuum tuning    – aggressive auto-vacuum for high-write tables.
 *
 * `apply()` is idempotent and safe to run on startup. Each step runs
 * independently: a failure in one step is captured in the report and the
 * remaining steps still execute, so partial progress is never lost.
 */

import { Pool } from 'pg';
import { IndexStrategy } from './index-strategy';
import { ContinuousAggregates } from './continuous-aggregates';
import { PartitionManager } from './partition-manager';
import { ColumnarCompression } from './compression';
import { VacuumTuning } from './vacuum-tuning';

/** Outcome of a single optimisation step within `apply()`. */
export interface StepResult<T> {
  ok: boolean;
  value: T | null;
  error?: string;
}

export interface OptimizationReport {
  indexes: StepResult<string[]>;
  aggregates: StepResult<boolean>;
  partitions: StepResult<string[]>;
  compression: StepResult<string[]>;
  vacuum: StepResult<string[]>;
}

function ok<T>(value: T): StepResult<T> {
  return { ok: true, value };
}

function fail<T>(error: unknown): StepResult<T> {
  return { ok: false, value: null, error: error instanceof Error ? error.message : String(error) };
}

export class TimeSeriesOptimizer {
  readonly partitions: PartitionManager;
  readonly indexes: IndexStrategy;
  readonly aggregates: ContinuousAggregates;
  readonly compression: ColumnarCompression;
  readonly vacuum: VacuumTuning;

  constructor(pool: Pool) {
    this.partitions = new PartitionManager(pool);
    this.indexes = new IndexStrategy(pool);
    this.aggregates = new ContinuousAggregates(pool);
    this.compression = new ColumnarCompression(pool);
    this.vacuum = new VacuumTuning(pool);
  }

  /**
   * Run every optimisation step once. Ordered so indexes exist before
   * aggregates are refreshed, and the vacuum policy is applied before the
   * sweep. Each step is wrapped independently so a single failure is recorded
   * in `ok: false` while the other steps still run.
   */
  async apply(): Promise<OptimizationReport> {
    let indexes: StepResult<string[]> = ok([]);
    try {
      indexes = ok(await this.indexes.ensureAll());
    } catch (err) {
      indexes = fail(err);
    }

    let aggregates: StepResult<boolean> = ok(false);
    try {
      aggregates = ok(await this.aggregates.refresh());
    } catch (err) {
      aggregates = fail(err);
    }

    let partitions: StepResult<string[]> = ok([]);
    try {
      const detached = await this.partitions.detachExpiredPartitions();
      partitions = ok(detached.filter((d) => d.detached).map((d) => d.partitionName));
    } catch (err) {
      partitions = fail(err);
    }

    let compression: StepResult<string[]> = ok([]);
    try {
      compression = ok(await this.compression.convertColdPartitions());
    } catch (err) {
      compression = fail(err);
    }

    let vacuum: StepResult<string[]> = ok([]);
    try {
      vacuum = ok(await this.vacuum.applyToPartitionedTable());
    } catch (err) {
      vacuum = fail(err);
    }

    return { indexes, aggregates, partitions, compression, vacuum };
  }
}
