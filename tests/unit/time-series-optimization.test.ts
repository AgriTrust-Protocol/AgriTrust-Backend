import { describe, it, expect, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import {
  PartitionManager,
  dayPartitionName,
  partitionNameToDate,
  PARTITION_PREFIX,
  ROLLING_WINDOW_DAYS,
} from '../../src/db/partition-manager';
import {
  IndexStrategy,
  INDEX_STRATEGY,
  BRIN_INDEX_DDL,
  PARTIAL_GIN_INDEX_DDL,
} from '../../src/db/index-strategy';
import { ContinuousAggregates, HOURLY_AGG, DAILY_AGG } from '../../src/db/continuous-aggregates';
import { ColumnarCompression } from '../../src/db/compression';
import { VacuumTuning, VACUUM_SCALE_FACTOR, VACUUM_THRESHOLD } from '../../src/db/vacuum-tuning';
import { TimeSeriesOptimizer } from '../../src/db/time-series';

// ─── Capturing fake Pool ─────────────────────────────────────────────────────
// Records every query and returns caller-supplied rows so we can assert on the
// SQL the managers emit without needing a live database.
interface QueryLog {
  sql: string;
  params: unknown[];
}

const NO_ROWS = { rows: [] as unknown[], rowCount: 0 };

function makePool(handler?: (sql: string, params: unknown[]) => { rows: unknown[] }): Pool {
  const log: QueryLog[] = [];
  const pool = {
    query: async (query: string | { text: string }, values?: unknown[]) => {
      const sql = typeof query === 'string' ? query : query.text;
      const params = values ?? [];
      log.push({ sql, params });
      const result = handler ? handler(sql, params) : { rows: NO_ROWS.rows };
      return { rows: result.rows, rowCount: result.rows.length };
    },
    __log: log,
  };
  return pool as unknown as Pool;
}

function captureQueries(pool: Pool): QueryLog[] {
  return (pool as unknown as { __log: QueryLog[] }).__log;
}

function withHandler(pool: Pool, value: unknown): Pool {
  const log = captureQueries(pool);
  return {
    query: async (query: string | { text: string }, values?: unknown[]) => {
      const sql = typeof query === 'string' ? query : query.text;
      const params = values ?? [];
      log.push({ sql, params });
      return { rows: [value] as unknown[], rowCount: 1 };
    },
    __log: log,
  } as unknown as Pool;
}

// ─── Partition manager ───────────────────────────────────────────────────────

describe('partition-manager', () => {
  describe('pure partition naming logic', () => {
    it('derives the UTC daily partition name for a timestamp', () => {
      const ts = new Date('2026-08-27T20:15:00Z');
      expect(dayPartitionName(ts)).toBe(`${PARTITION_PREFIX}2026_08_27`);
    });

    it('parses a partition name back into a date', () => {
      const parsed = partitionNameToDate('sensor_readings_2026_08_27');
      expect(parsed?.toISOString()).toBe('2026-08-27T00:00:00.000Z');
    });

    it('returns null for non-conforming names', () => {
      expect(partitionNameToDate('sensor_readings_bad')).toBeNull();
      expect(partitionNameToDate('environmental_logs_2026_08_27')).toBeNull();
    });
  });

  describe('rolling window constant', () => {
    it('defaults to a 90-day window as specified', () => {
      expect(ROLLING_WINDOW_DAYS).toBe(90);
    });
  });

  describe('detachExpiredPartitions', () => {
    it('detaches each expired partition and reports the outcome', async () => {
      const pool = makePool((sql) => {
        if (sql.includes('pg_inherits')) {
          return {
            rows: [{ partition_name: 'sensor_readings_2026_01_01', partition_day: '2026-01-01' }],
          };
        }
        if (sql.includes('detach_sensor_readings_partition')) {
          return { rows: [{ detached_name: 'sensor_readings_2026_01_01' }] };
        }
        return { rows: [] };
      });
      const manager = new PartitionManager(pool, 90);

      const results = await manager.detachExpiredPartitions();
      expect(results).toEqual([{ partitionName: 'sensor_readings_2026_01_01', detached: true }]);

      const sql = captureQueries(pool)
        .map((q) => q.sql)
        .join('\n');
      // The specific expired partition is passed to the server detach function
      // so app bookkeeping and the server action can never drift.
      expect(sql).toContain('detach_sensor_readings_partition($1)');
      expect(captureQueries(pool).some((q) => q.params[0] === 'sensor_readings_2026_01_01')).toBe(
        true,
      );
    });
  });
});

// ─── Index strategy ──────────────────────────────────────────────────────────

describe('index-strategy', () => {
  it('defines BRIN with pages_per_range = 128 (per-partition template)', () => {
    expect(BRIN_INDEX_DDL).toMatch(/USING brin\s+\(farm_id, ts\)/);
    expect(BRIN_INDEX_DDL).toMatch(/pages_per_range = 128/);
  });

  it('defines a partial GIN over (sensor_type, tags) (per-partition template)', () => {
    expect(PARTIAL_GIN_INDEX_DDL).toMatch(/USING gin\s+\(sensor_type, tags\)/);
    expect(PARTIAL_GIN_INDEX_DDL).toMatch(/WHERE value IS NOT NULL/);
  });

  it('ensures indexes on every attached partition', async () => {
    const pool = makePool((sql) =>
      sql.includes('pg_inherits')
        ? { rows: [{ relname: 'sensor_readings_2026_08_27' }] }
        : { rows: [] },
    );
    const strategy = new IndexStrategy(pool);
    const created = await strategy.ensureAll();
    expect(created).toEqual([
      'idx_sensor_readings_2026_08_27_ts_brin',
      'idx_sensor_readings_2026_08_27_type_tags',
    ]);
    // The emitted DDL quotes the table identifier and uses 128-page BRIN.
    const ddl = captureQueries(pool)
      .map((q) => q.sql)
      .join('\n');
    expect(ddl).not.toContain('idx_"sensor');
    expect(ddl).toContain('pages_per_range = 128');
  });

  it('rejects unexpected partition names', async () => {
    const pool = makePool();
    const strategy = new IndexStrategy(pool);
    await expect(strategy.ensureOnPartition('INJECT')).rejects.toThrow(/partition name/i);
  });

  it('verifies index presence through pg_indexes', async () => {
    const pool = withHandler(makePool(), { count: 1 });
    const strategy = new IndexStrategy(pool);
    await expect(
      strategy.verify('sensor_readings_2026_08_27', 'idx_{table}_ts_brin'),
    ).resolves.toBe(true);
  });
});

// ─── Continuous aggregates ───────────────────────────────────────────────────

describe('continuous-aggregates', () => {
  it('refreshes via the server-side function', async () => {
    const pool = makePool();
    const aggs = new ContinuousAggregates(pool);
    const refreshed = await aggs.refresh();
    expect(refreshed).toBe(true);
    expect(captureQueries(pool)[0].sql).toContain('sp_refresh_sensor_aggregates');
  });

  it('exposes concurrent refresh statements for hourly/daily', async () => {
    const pool = makePool();
    const aggs = new ContinuousAggregates(pool);
    await aggs.refreshHourly();
    await aggs.refreshDaily();
    const sql = captureQueries(pool)
      .map((q) => q.sql)
      .join('\n');
    expect(sql).toContain(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${HOURLY_AGG}`);
    expect(sql).toContain(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${DAILY_AGG}`);
  });

  it('scheduler start/stop is safe and does not throw', async () => {
    const pool = makePool();
    const aggs = new ContinuousAggregates(pool);
    const handle = aggs.start(1000);
    expect(() => handle.stop()).not.toThrow();
    // Starting again after stop also must not throw.
    const second = aggs.start(1000);
    second.stop();
  });

  it('ensures view DDL includes avg/min/max/count aggregates', async () => {
    const pool = makePool();
    const aggs = new ContinuousAggregates(pool);
    await aggs.ensureViews();
    const sql = captureQueries(pool)
      .map((q) => q.sql)
      .join('\n');
    expect(sql).toMatch(/AVG\(value\)/);
    expect(sql).toMatch(/MIN\(value\)/);
    expect(sql).toMatch(/MAX\(value\)/);
    expect(sql).toMatch(/COUNT\(\*\)/);
  });
});

// ─── Columnar compression ────────────────────────────────────────────────────

describe('columnar-compression', () => {
  it('detects the columnar access method when present', async () => {
    const pool = withHandler(makePool(), { amname: 'columnar' });
    const compression = new ColumnarCompression(pool);
    await expect(compression.isColumnarAvailable()).resolves.toBe(true);
  });

  it('skips conversion when the columnar access method is absent', async () => {
    const pool = makePool();
    const compression = new ColumnarCompression(pool);
    await expect(compression.convertColdPartitions()).resolves.toEqual([]);
    // Only the capability probe ran; no ALTER was issued.
    expect(captureQueries(pool).map((q) => q.sql)).toEqual([expect.stringContaining('pg_am')]);
  });
});

// ─── Vacuum tuning ───────────────────────────────────────────────────────────

describe('vacuum-tuning', () => {
  it('uses scale_factor 0.01 and threshold 1000', () => {
    expect(VACUUM_SCALE_FACTOR).toBe(0.01);
    expect(VACUUM_THRESHOLD).toBe(1_000);
  });

  it('issues an ALTER TABLE with tuned autovacuum settings', async () => {
    const pool = makePool();
    const tuning = new VacuumTuning(pool);
    await tuning.apply();
    const { sql, params } = captureQueries(pool)[0];
    expect(sql).toContain('ALTER TABLE');
    expect(sql).toContain('autovacuum_vacuum_scale_factor');
    expect(params).toContain('0.01');
    expect(params).toContain('1000');
  });
});

// ─── Orchestrator ────────────────────────────────────────────────────────────

describe('time-series-optimizer', () => {
  it('composes a full optimisation report with per-step outcomes', async () => {
    const pool = makePool();
    const optimizer = new TimeSeriesOptimizer(pool);
    (optimizer.indexes as unknown as { ensureAll: () => Promise<string[]> }).ensureAll =
      async () => ['idx_sensor_readings_2026_08_27_ts_brin'];
    (optimizer.aggregates as unknown as { refresh: () => Promise<boolean> }).refresh = async () =>
      true;
    (
      optimizer.partitions as unknown as {
        detachExpiredPartitions: () => Promise<unknown[]>;
      }
    ).detachExpiredPartitions = async () => [
      { partitionName: 'sensor_readings_2026_01_01', detached: true },
    ];
    (
      optimizer.compression as unknown as {
        convertColdPartitions: () => Promise<string[]>;
      }
    ).convertColdPartitions = async () => ['sensor_readings_2026_01_01'];
    (
      optimizer.vacuum as unknown as {
        applyToPartitionedTable: () => Promise<string[]>;
      }
    ).applyToPartitionedTable = async () => ['sensor_readings'];

    const report = await optimizer.apply();

    expect(report.indexes).toEqual({ ok: true, value: ['idx_sensor_readings_2026_08_27_ts_brin'] });
    expect(report.aggregates).toEqual({ ok: true, value: true });
    expect(report.partitions).toEqual({
      ok: true,
      value: ['sensor_readings_2026_01_01'],
    });
    expect(report.compression).toEqual({ ok: true, value: ['sensor_readings_2026_01_01'] });
    expect(report.vacuum).toEqual({ ok: true, value: ['sensor_readings'] });
  });

  it('records a step failure without aborting the remaining steps', async () => {
    const pool = makePool();
    const optimizer = new TimeSeriesOptimizer(pool);
    const stubbed = optimizer as unknown as {
      indexes: { ensureAll: () => Promise<string[]> };
      aggregates: { refresh: () => Promise<boolean> };
      partitions: { detachExpiredPartitions: () => Promise<unknown[]> };
      compression: { convertColdPartitions: () => Promise<string[]> };
      vacuum: { applyToPartitionedTable: () => Promise<string[]> };
    };
    stubbed.indexes = { ensureAll: async () => Promise.reject(new Error('index boom')) };
    stubbed.aggregates = { refresh: async () => true };
    stubbed.partitions = {
      detachExpiredPartitions: async () => [
        { partitionName: 'sensor_readings_2026_01_01', detached: true },
      ],
    };
    stubbed.compression = { convertColdPartitions: async () => [] };
    stubbed.vacuum = { applyToPartitionedTable: async () => ['sensor_readings'] };

    const report = await optimizer.apply();

    expect(report.indexes.ok).toBe(false);
    expect(report.indexes.error).toContain('index boom');
    // Later steps still ran and reported success.
    expect(report.vacuum.ok).toBe(true);
    expect(report.vacuum.value).toEqual(['sensor_readings']);
  });
});
