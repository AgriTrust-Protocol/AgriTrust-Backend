CREATE TABLE IF NOT EXISTS farm_activity_audit_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id UUID NOT NULL,
    activity_type TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_id UUID NOT NULL,
    location JSONB NOT NULL,
    payload JSONB NOT NULL,
    prev_hash BYTEA NOT NULL CHECK (octet_length(prev_hash) = 32),
    hash BYTEA NOT NULL UNIQUE CHECK (octet_length(hash) = 32),
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ,
    cold_storage_key TEXT,
    CHECK (jsonb_typeof(location) = 'object'),
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_farm_activity_audit_chain
    ON farm_activity_audit_events (farm_id, timestamp, inserted_at);
CREATE INDEX IF NOT EXISTS idx_farm_activity_audit_activity
    ON farm_activity_audit_events (activity_type);
CREATE INDEX IF NOT EXISTS idx_farm_activity_audit_actor
    ON farm_activity_audit_events (actor_id);
CREATE INDEX IF NOT EXISTS idx_farm_activity_audit_archival
    ON farm_activity_audit_events (timestamp) WHERE archived_at IS NULL;
