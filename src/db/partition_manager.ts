import { Pool, PoolClient } from 'pg';
import { addUtcDays, formatDateKey, quoteIdentifier, sqlDateLiteral, utcDay } from './sql_ident';

export interface PartitionManagerOptions {
  tableName?: string;
  retentionDays?: number;
  precreateDays?: number;
  archiveSchema?: string;
}

export interface PartitionPlan {
  createSql: string[];
  detachSql: string[];
}

export class SensorPartitionManager {
  private readonly tableName: string;
  private readonly retentionDays: number;
  private readonly precreateDays: number;
  private readonly archiveSchema: string;

  constructor(private readonly client: Pool | PoolClient, options: PartitionManagerOptions = {}) {
    this.tableName = options.tableName ?? 'sensor_readings';
    this.retentionDays = options.retentionDays ?? 90;
    this.precreateDays = options.precreateDays ?? 7;
    this.archiveSchema = options.archiveSchema ?? 'sensor_archive';
  }

  buildPlan(referenceDate = new Date()): PartitionPlan {
    const today = utcDay(referenceDate);
    const createSql: string[] = [];
    for (let offset = -1; offset <= this.precreateDays; offset += 1) {
      createSql.push(this.createPartitionSql(addUtcDays(today, offset)));
    }
    const expiredDay = addUtcDays(today, -this.retentionDays - 1);
    return { createSql, detachSql: [this.detachAndArchiveSql(expiredDay)] };
  }

  async ensureParentTable(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(this.tableName)} (
      id BIGSERIAL,
      farm_id UUID NOT NULL,
      sensor_id UUID,
      sensor_type TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      value DOUBLE PRECISION NOT NULL,
      unit TEXT,
      tags JSONB NOT NULL DEFAULT '{}'::jsonb,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id, ts)
    ) PARTITION BY RANGE (ts)`);
  }

  async maintain(referenceDate = new Date()): Promise<void> {
    await this.ensureParentTable();
    const plan = this.buildPlan(referenceDate);
    for (const sql of [...plan.createSql, ...plan.detachSql]) {
      await this.client.query(sql);
    }
  }

  createPartitionSql(day: Date): string {
    const start = utcDay(day);
    const end = addUtcDays(start, 1);
    return `CREATE TABLE IF NOT EXISTS ${this.partitionName(start)} PARTITION OF ${quoteIdentifier(this.tableName)} FOR VALUES FROM ('${sqlDateLiteral(start)}') TO ('${sqlDateLiteral(end)}')`;
  }

  detachAndArchiveSql(day: Date): string {
    const partition = this.partitionName(utcDay(day));
    return `DO $$
BEGIN
  IF to_regclass('${partition.replace(/"/g, '')}') IS NOT NULL THEN
    CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.archiveSchema)};
    ALTER TABLE ${quoteIdentifier(this.tableName)} DETACH PARTITION ${partition};
    ALTER TABLE ${partition} SET SCHEMA ${quoteIdentifier(this.archiveSchema)};
  END IF;
END $$`;
  }

  partitionName(day: Date): string {
    return quoteIdentifier(`${this.tableName}_${formatDateKey(day)}`);
  }
}
