import { Pool, PoolClient } from 'pg';
import { ScheduledJob, ScheduledJobKind, ScheduledJobStatus } from './types';

export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_LEASE_REFRESH_MS = 10_000;
export const MAX_JOB_RETRIES = 3;

function mapJob(row: Record<string, unknown>): ScheduledJob {
  return {
    jobId: row.job_id as string,
    type: row.type as ScheduledJobKind,
    operation: row.operation as string,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    scheduledAt: row.scheduled_at as Date,
    leaseUntil: (row.lease_until as Date | null) ?? null,
    leaseOwner: (row.lease_owner as string | null) ?? null,
    status: row.status as ScheduledJobStatus,
    retryCount: Number(row.retry_count ?? 0),
    cronExpression: (row.cron_expression as string | null) ?? null,
    parentJobId: (row.parent_job_id as string | null) ?? null,
    createdAt: row.created_at as Date | undefined,
    updatedAt: row.updated_at as Date | undefined,
  };
}

export class PostgresJobQueue {
  constructor(private readonly pool: Pool, private readonly leaseTtlMs = DEFAULT_LEASE_TTL_MS) {}

  async enqueue(job: Omit<ScheduledJob, 'status' | 'retryCount' | 'leaseUntil' | 'leaseOwner'> & Partial<Pick<ScheduledJob, 'status' | 'retryCount'>>): Promise<ScheduledJob> {
    const result = await this.pool.query(
      `INSERT INTO scheduled_jobs (job_id, type, operation, payload, scheduled_at, status, retry_count, cron_expression, parent_job_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [job.jobId, job.type, job.operation, job.payload, job.scheduledAt, job.status ?? 'pending', job.retryCount ?? 0, job.cronExpression ?? null, job.parentJobId ?? null],
    );
    return mapJob(result.rows[0]);
  }

  async claimNextJob(workerId: string): Promise<ScheduledJob | null> {
    return this.inTransaction(async (client) => {
      const result = await client.query(
        `WITH next_job AS (
           SELECT job_id
           FROM scheduled_jobs
           WHERE scheduled_at <= NOW()
             AND retry_count < $2
             AND (status = 'pending' OR (status IN ('leased', 'running') AND lease_until <= NOW()))
           ORDER BY scheduled_at ASC, created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE scheduled_jobs sj
         SET status = 'leased', lease_owner = $1, lease_until = NOW() + ($3::int * INTERVAL '1 millisecond'), updated_at = NOW()
         FROM next_job
         WHERE sj.job_id = next_job.job_id
         RETURNING sj.*`,
        [workerId, MAX_JOB_RETRIES, this.leaseTtlMs],
      );
      return result.rowCount ? mapJob(result.rows[0]) : null;
    });
  }

  async refreshLease(jobId: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE scheduled_jobs
       SET lease_until = NOW() + ($3::int * INTERVAL '1 millisecond'), status = 'running', updated_at = NOW()
       WHERE job_id = $1 AND lease_owner = $2 AND lease_until > NOW() AND status IN ('leased', 'running')`,
      [jobId, workerId, this.leaseTtlMs],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async complete(jobId: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE scheduled_jobs SET status = 'succeeded', lease_until = NULL, lease_owner = NULL, updated_at = NOW()
       WHERE job_id = $1 AND lease_owner = $2 AND status IN ('leased', 'running')`,
      [jobId, workerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async failOrRetry(job: ScheduledJob, workerId: string, errorMessage: string): Promise<'pending' | 'failed'> {
    const nextRetry = job.retryCount + 1;
    const failed = nextRetry >= MAX_JOB_RETRIES;
    await this.pool.query(
      `UPDATE scheduled_jobs
       SET status = $3, retry_count = $4, lease_until = NULL, lease_owner = NULL,
           last_error = $5, scheduled_at = CASE WHEN $3 = 'pending' THEN NOW() + ($6::int * INTERVAL '1 millisecond') ELSE scheduled_at END,
           updated_at = NOW()
       WHERE job_id = $1 AND lease_owner = $2`,
      [job.jobId, workerId, failed ? 'failed' : 'pending', nextRetry, errorMessage, Math.min(30_000, 1000 * 2 ** job.retryCount)],
    );
    return failed ? 'failed' : 'pending';
  }

  private async inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
