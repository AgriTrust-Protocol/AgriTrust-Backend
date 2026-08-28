-- AgriTrust Protocol – Distributed Job Scheduler for Farm Operations (#168)
--
-- PostgreSQL-backed job scheduler that complements the real-time Redis priority
-- queue with time-based orchestration. It stores cron, delayed, and
-- dependency-triggered farm-operation jobs in a `scheduled_jobs` table and uses
-- lease-based worker claiming (`SELECT ... FOR UPDATE SKIP LOCKED`) so that
-- multiple scheduler replicas never execute the same job twice.
--
--   scheduled_jobs – the durable job ledger.
--   idx_scheduled_jobs_due – the work queue window: `status='pending' AND
--     scheduled_at <= now()`. Ordered by scheduled_at so `claim_due` always
--     takes the oldest eligible job first.
--   claim_due_scheduled_job(job_id, lease_until, worker_id) – atomically claims
--     one due job, stamps lease metadata, and returns the JSON payload. `SKIP
--     LOCKED` means concurrent claimers on other replicas simply get the next
--     job instead of blocking.
--   complete_scheduled_job(status, job_id, lease_owner) – ack/fail path guarded
--     by the lease owner.
--   refresh_scheduled_job_lease(lease_until, job_id, lease_owner) – renews a
--     lease before it expires (30s TTL, refreshed every 10s).
--   reclaim_expired_scheduled_jobs() – requeues jobs whose lease lapsed without
--     completion so a crashed worker cannot strand work.
--   bump_scheduled_job_attempts() – increments retry_count on a terminal
--     failure so a doomed job fires an alert after `max_retries` is reached.
--
-- Status lifecycle: pending -> running -> succeeded | failed
-- A `failed` job carries a non-null `retry_count`; the scheduler re-enqueues it
-- as a fresh `pending` row while retries remain and moves it to `failed` (and
-- fires an alert) once `max_retries` is exhausted.

-- migrate:up

CREATE TABLE IF NOT EXISTS scheduled_jobs (
    job_id       TEXT        PRIMARY KEY,
    type         TEXT        NOT NULL,                 -- 'cron' | 'delayed' | 'dependency'
    payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_until  TIMESTAMPTZ,                          -- NULL when not leased
    lease_owner  TEXT,                                 -- scheduler/worker id holding the lease
    status       TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    retry_count  INTEGER     NOT NULL DEFAULT 0,
    cron_expr    TEXT,                                 -- 5-field expr for cron jobs
    depends_on   TEXT[],                               -- job_ids that must succeed first
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The claimer guarantees one worker at a time, so a plain index on the due
-- window ordered by scheduled_at gives the hot poll path an index-ordered scan.
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
    ON scheduled_jobs (scheduled_at)
    WHERE status = 'pending';

-- Find dependents of a completed job quickly.
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_depends_on
    ON scheduled_jobs USING gin (depends_on);

-- Lease bookkeeping for reclamation.
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_lease
    ON scheduled_jobs (lease_until)
    WHERE status = 'running';

DROP FUNCTION IF EXISTS claim_due_scheduled_job(TEXT, TIMESTAMPTZ, TEXT);
CREATE FUNCTION claim_due_scheduled_job(
    p_job_id   TEXT,
    p_lease_until TIMESTAMPTZ,
    p_worker_id  TEXT
)
RETURNS JSONB
LANGUAGE sql
AS $$
    SELECT to_jsonb(sj)
    FROM scheduled_jobs sj
    WHERE sj.job_id = p_job_id
      AND sj.status = 'pending'
      AND sj.scheduled_at <= NOW()
    FOR UPDATE SKIP LOCKED OF sj
$$;

DROP FUNCTION IF EXISTS claim_next_scheduled_job(TIMESTAMPTZ, TEXT);
CREATE FUNCTION claim_next_scheduled_job(
    p_lease_until TIMESTAMPTZ,
    p_worker_id  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    claimed JSONB;
BEGIN
    SELECT to_jsonb(sj)
    INTO claimed
    FROM scheduled_jobs sj
    WHERE sj.status = 'pending' AND sj.scheduled_at <= NOW()
    ORDER BY sj.scheduled_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF claimed IS NOT NULL THEN
        UPDATE scheduled_jobs
        SET status = 'running',
            lease_until = p_lease_until,
            lease_owner = p_worker_id,
            updated_at = NOW()
        WHERE job_id = claimed->>'job_id';
    END IF;

    RETURN claimed;
END;
$$;

DROP FUNCTION IF EXISTS complete_scheduled_job(TEXT, TEXT, TEXT);
CREATE FUNCTION complete_scheduled_job(
    p_status    TEXT,   -- 'succeeded' | 'failed'
    p_job_id    TEXT,
    p_lease_owner TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    updated INTEGER;
BEGIN
    UPDATE scheduled_jobs
    SET status = p_status,
        lease_until = NULL,
        lease_owner = NULL,
        retry_count = retry_count + 1,
        updated_at = NOW()
    WHERE job_id = p_job_id
      AND lease_owner = p_lease_owner;
    GET DIAGNOSTICS updated = ROW_COUNT;
    RETURN updated > 0;
END;
$$;

DROP FUNCTION IF EXISTS refresh_scheduled_job_lease(TIMESTAMPTZ, TEXT, TEXT);
CREATE FUNCTION refresh_scheduled_job_lease(
    p_lease_until TIMESTAMPTZ,
    p_job_id      TEXT,
    p_lease_owner TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
AS $$
    SELECT EXISTS (
        UPDATE scheduled_jobs
        SET lease_until = p_lease_until,
            updated_at = NOW()
        WHERE job_id = p_job_id
          AND lease_owner = p_lease_owner
          AND status = 'running'
    );
$$;

-- Requeue every job whose lease lapsed without completion. The caller decides
-- whether to preserve `retry_count` or reset it; the scheduler keeps it so a
-- permanently stuck job still exhausts its retries and fires the alert.
DROP FUNCTION IF EXISTS reclaim_expired_scheduled_jobs(TIMESTAMPTZ);
CREATE FUNCTION reclaim_expired_scheduled_jobs(p_now TIMESTAMPTZ DEFAULT NOW())
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    requeued INTEGER := 0;
BEGIN
    UPDATE scheduled_jobs
    SET status = 'pending',
        lease_until = NULL,
        lease_owner = NULL,
        updated_at = NOW()
    WHERE status = 'running'
      AND lease_until < p_now;
    GET DIAGNOSTICS requeued = ROW_COUNT;
    RETURN requeued;
END;
$$;

-- When a scheduled job is scheduled, `scheduled_at` may be in the future. The
-- scheduler re-arms a cron/delayed job by inserting a fresh pending row; the
-- previous run's row is terminal and never scheduled again. No triggers needed.

-- migrate:down
DROP FUNCTION IF EXISTS claim_due_scheduled_job(TEXT, TIMESTAMPTZ, TEXT);
DROP FUNCTION IF EXISTS claim_next_scheduled_job(TIMESTAMPTZ, TEXT);
DROP FUNCTION IF EXISTS complete_scheduled_job(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS refresh_scheduled_job_lease(TIMESTAMPTZ, TEXT, TEXT);
DROP FUNCTION IF EXISTS reclaim_expired_scheduled_jobs(TIMESTAMPTZ);
DROP TABLE IF EXISTS scheduled_jobs;