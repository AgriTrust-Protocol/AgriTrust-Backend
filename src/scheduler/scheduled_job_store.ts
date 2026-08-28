import { Pool } from 'pg';
import {
  SCHEDULED_JOB_LEASE_MS,
  ScheduledJob,
  ScheduledJobRow,
  ScheduledJobStatus,
  ScheduledJobType,
} from './types';

/**
 * PostgreSQL-backed store for the distributed scheduler (issue #168).
 *
 * Backs the `scheduled_jobs` table and its per-operation SQL functions
 * (created by the `20260828000001_create_scheduled_jobs` migration). The claim
 * path uses `SELECT ... FOR UPDATE SKIP LOCKED` so concurrent scheduler
 * replicas each grab a distinct due job rather than blocking on the same row.
 */
export class ScheduledJobStore {
  constructor(private readonly pool: Pool) {}

  /** Insert (or replace) one scheduled job. */
  async schedule(
    job: Pick<
      ScheduledJob,
      'job_id' | 'type' | 'payload' | 'scheduled_at' | 'cron_expr' | 'depends_on' | 'retry_count'
    >,
    status: ScheduledJobStatus = 'pending',
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO scheduled_jobs
         (job_id, type, payload, scheduled_at, status, retry_count, cron_expr, depends_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (job_id) DO UPDATE SET
         type = EXCLUDED.type,
         payload = EXCLUDED.payload,
         scheduled_at = EXCLUDED.scheduled_at,
         status = EXCLUDED.status,
         retry_count = EXCLUDED.retry_count,
         cron_expr = EXCLUDED.cron_expr,
         depends_on = EXCLUDED.depends_on,
         updated_at = NOW()`,
      [
        job.job_id,
        job.type,
        JSON.stringify(job.payload),
        job.scheduled_at,
        status,
        job.retry_count ?? 0,
        job.cron_expr ?? null,
        job.depends_on ?? null,
      ],
    );
  }

  /** Re-arm a cron/delayed job as a fresh pending row at a new run time. */
  async reschedule(jobId: string, nextTime: Date): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_jobs
        SET status = 'pending',
            scheduled_at = $2,
            lease_until = NULL,
            lease_owner = NULL,
            updated_at = NOW()
        WHERE job_id = $1`,
      [jobId, nextTime],
    );
  }

  /**
   * Atomically claim the next due job under a lease for `workerId`.
   * Returns the claimed row, or null when nothing is due.
   */
  async claimNextDue(workerId: string, now = new Date()): Promise<ScheduledJobRow | null> {
    const leaseUntil = new Date(now.getTime() + SCHEDULED_JOB_LEASE_MS);
    const result = await this.pool.query('SELECT claim_next_scheduled_job($1, $2) AS claimed', [
      leaseUntil.toISOString(),
      workerId,
    ]);
    const claimed = this.readJsonbRow(result.rows[0]?.claimed);
    if (!claimed) return null;

    // The SQL function already stamped the lease; return the refreshed row.
    return claimed;
  }

  /** Acknowledge completion of a leased job (guarded by the lease owner). */
  async complete(
    jobId: string,
    workerId: string,
    status: 'succeeded' | 'failed',
  ): Promise<boolean> {
    const result = await this.pool.query('SELECT complete_scheduled_job($1, $2, $3) AS ok', [
      status,
      jobId,
      workerId,
    ]);
    return !!result.rows[0]?.ok;
  }

  /** Renew the lease before it expires (30s TTL refreshed every 10s). */
  async refreshLease(jobId: string, workerId: string, now = new Date()): Promise<boolean> {
    const leaseUntil = new Date(now.getTime() + SCHEDULED_JOB_LEASE_MS);
    const result = await this.pool.query('SELECT refresh_scheduled_job_lease($1, $2, $3) AS ok', [
      leaseUntil.toISOString(),
      jobId,
      workerId,
    ]);
    return !!result.rows[0]?.ok;
  }

  /** Requeue running jobs whose lease lapsed; returns how many were reclaimed. */
  async reclaimExpiredLeases(now = new Date()): Promise<number> {
    const result = await this.pool.query('SELECT reclaim_expired_scheduled_jobs($1) AS n', [
      now.toISOString(),
    ]);
    return Number(result.rows[0]?.n ?? 0);
  }

  /** Fetch a single job (admin inspection / dependency resolution). */
  async get(jobId: string): Promise<ScheduledJobRow | null> {
    const result = await this.pool.query('SELECT * FROM scheduled_jobs WHERE job_id = $1', [jobId]);
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  /** Fetch all scheduled jobs (snapshot / dependency resolution). */
  async list(): Promise<ScheduledJobRow[]> {
    const result = await this.pool.query('SELECT * FROM scheduled_jobs ORDER BY scheduled_at');
    return result.rows.map((row) => this.mapRow(row));
  }

  private readJsonbRow(value: unknown): ScheduledJobRow | null {
    if (!value) return null;
    if (typeof value === 'string') return JSON.parse(value) as ScheduledJobRow;
    // When pg-mem or a JSONB-aware driver returns the row object directly.
    return this.mapRow(value as Record<string, unknown>);
  }

  private mapRow(row: Record<string, unknown>): ScheduledJobRow {
    return {
      job_id: String(row.job_id),
      type: row.type as ScheduledJobType,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {}),
      scheduled_at: new Date(row.scheduled_at as string),
      lease_until: row.lease_until == null ? null : new Date(row.lease_until as string),
      lease_owner: row.lease_owner == null ? null : String(row.lease_owner),
      status: row.status as ScheduledJobStatus,
      retry_count: Number(row.retry_count ?? 0),
      cron_expr: row.cron_expr == null ? null : String(row.cron_expr),
      depends_on:
        row.depends_on == null
          ? null
          : Array.isArray(row.depends_on)
            ? (row.depends_on as string[])
            : ((row.depends_on as unknown as string)
                .replace(/^{|}$/g, '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean) as string[]),
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
