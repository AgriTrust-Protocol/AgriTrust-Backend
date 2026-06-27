-- AgriTrust Protocol – Batch Hash Log
-- Append-only hash chain for multi-source batch integrity.
-- Each ingestion source (sensor, drone, inspector) appends one row;
-- the final integrity_hash is computed at certification time as
-- SHA256(concat of all source_hash values ordered by id).

CREATE TABLE IF NOT EXISTS batch_hash_log (
    id          BIGSERIAL   PRIMARY KEY,
    batch_id    TEXT        NOT NULL,
    source      TEXT        NOT NULL,
    source_hash TEXT        NOT NULL,   -- hex-encoded SHA-256 of source data
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bhl_batch_id ON batch_hash_log (batch_id, id);

-- batches table integrity_hash column (idempotent ALTER).
ALTER TABLE batches ADD COLUMN IF NOT EXISTS integrity_hash TEXT;

-- Per-(batch, source) advisory lock key: distributes into 64-bit space.
CREATE OR REPLACE FUNCTION batch_source_lock_key(p_batch_id TEXT, p_source TEXT)
RETURNS BIGINT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT ('x' || substr(md5(p_batch_id || ':' || p_source), 1, 16))::bit(64)::bigint;
$$;
