-- AgriTrust Protocol – Batch Workflow Tables
-- Backs batch status transitions with optimistic locking, idempotency,
-- and atomic transition validation (#31).
--
-- batches                 : one row per batch; holds status and OCC version.
-- batch_audit_events      : append-only audit log with idempotency guard.
-- processed_transitions   : at-most-once dedup table for transitions.
-- validate_transition()   : server-side function for atomic state validation.
-- trg_validate_transition : BEFORE UPDATE trigger that enforces the state DAG.

CREATE TABLE IF NOT EXISTS batches (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status      TEXT NOT NULL DEFAULT 'REGISTERED',
    version     INT NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS batch_audit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id        UUID NOT NULL REFERENCES batches(id),
    transition_type TEXT NOT NULL,
    status_before   TEXT NOT NULL,
    status_after    TEXT NOT NULL,
    idempotency_key UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Dedup: only one audit event per batch per transition attempt.
    UNIQUE(batch_id, transition_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_batch_audit_events_batch
    ON batch_audit_events (batch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS processed_transitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id        UUID NOT NULL REFERENCES batches(id),
    transition_id   UUID NOT NULL,
    status_before   TEXT NOT NULL,
    status_after    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- At-most-once: only one transition of a given type per batch.
    UNIQUE(batch_id, status_before, status_after)
);

-- Atomic transition validation function.
-- Called within the UPDATE transaction so validation is serialised with the write.
CREATE OR REPLACE FUNCTION validate_transition(
    current_status TEXT,
    new_status TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    valid BOOLEAN;
BEGIN
    SELECT new_status = ANY(valid_next)
    INTO valid
    FROM (VALUES
        ('REGISTERED', ARRAY['INSPECTED']::TEXT[]),
        ('INSPECTED',  ARRAY['CERTIFIED']::TEXT[]),
        ('CERTIFIED',  ARRAY['SHIPPED']::TEXT[]),
        ('SHIPPED',    ARRAY['DELIVERED']::TEXT[]),
        ('DELIVERED',  ARRAY[]::TEXT[])
    ) AS t(status, valid_next)
    WHERE t.status = current_status;

    RETURN COALESCE(valid, FALSE);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- BEFORE UPDATE trigger: enforces that any direct UPDATE to batches.status
-- (including those bypassing the application layer) is a valid transition.
-- This is the atomic backstop that makes validation and update indivisible.
CREATE OR REPLACE FUNCTION trg_validate_batch_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT validate_transition(OLD.status, NEW.status) THEN
        RAISE EXCEPTION 'Invalid transition: % → %', OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_transition ON batches;
CREATE TRIGGER trg_validate_transition
    BEFORE UPDATE OF status ON batches
    FOR EACH ROW
    EXECUTE FUNCTION trg_validate_batch_transition();
