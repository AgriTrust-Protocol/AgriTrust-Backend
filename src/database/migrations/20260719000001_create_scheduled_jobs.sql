CREATE TABLE IF NOT EXISTS scheduled_jobs (
  job_id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('cron', 'delayed', 'dependency')),
  operation TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ,
  lease_owner TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'running', 'succeeded', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  cron_expression TEXT,
  parent_job_id TEXT REFERENCES scheduled_jobs(job_id) ON DELETE SET NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_claimable
  ON scheduled_jobs (scheduled_at, created_at)
  WHERE status IN ('pending', 'leased', 'running');

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_parent_status
  ON scheduled_jobs (parent_job_id, status)
  WHERE parent_job_id IS NOT NULL;
