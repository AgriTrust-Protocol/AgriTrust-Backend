import { Pool, PoolClient } from 'pg';
import { addUtcDays, formatDateKey, quoteIdentifier, utcDay } from './sql_ident';

export interface CompressionOptions {
  tableName?: string;
  coldAfterDays?: number;
  accessMethod?: 'columnar' | string;
}

export function coldPartitionNames(referenceDate = new Date(), options: CompressionOptions = {}): string[] {
  const tableName = options.tableName ?? 'sensor_readings';
  const coldAfterDays = options.coldAfterDays ?? 7;
  const cutoff = addUtcDays(utcDay(referenceDate), -coldAfterDays);
  return [quoteIdentifier(`${tableName}_${formatDateKey(cutoff)}`)];
}

export function compressionSqlForPartition(partitionName: string, accessMethod = 'columnar'): string {
  return `ALTER TABLE ${partitionName} SET ACCESS METHOD ${quoteIdentifier(accessMethod)}`;
}

export async function compressColdSensorPartitions(client: Pool | PoolClient, referenceDate = new Date(), options: CompressionOptions = {}): Promise<void> {
  const accessMethod = options.accessMethod ?? 'columnar';
  for (const partition of coldPartitionNames(referenceDate, options)) {
    await client.query(`DO $$
BEGIN
  IF to_regclass('${partition.replace(/"/g, '')}') IS NOT NULL THEN
    EXECUTE '${compressionSqlForPartition(partition, accessMethod).replace(/'/g, "''")}';
  END IF;
END $$`);
  }
}
