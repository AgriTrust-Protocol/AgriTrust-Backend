-- AgriTrust Protocol – Cryptographic Keys & Rotation Audit Log
-- Backs the Zero-Downtime Key Rotation Orchestrator (issue #45).
--
-- keys: Stores public/private key pairs with phase management.
--       Private keys MUST be stored encrypted.
-- key_rotation_audit_log: Audit trail for all key rotation events.

CREATE TABLE IF NOT EXISTS keys (
    id                      BIGSERIAL PRIMARY KEY,
    purpose                 TEXT NOT NULL,
    type                    TEXT NOT NULL,
    public_key              TEXT NOT NULL,
    encrypted_private_key   TEXT NOT NULL,
    phase                   TEXT NOT NULL, -- Active, Grace, Retired
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at              TIMESTAMPTZ,   -- Set when entering Grace phase
    fingerprint             TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_keys_purpose_phase ON keys (purpose, phase);

CREATE TABLE IF NOT EXISTS key_rotation_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    key_id      BIGINT NOT NULL,
    purpose     TEXT NOT NULL,
    phase       TEXT NOT NULL,
    rotated_by  TEXT NOT NULL,
    rotated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fingerprint TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_key_rotation_audit_log_key_id ON key_rotation_audit_log (key_id);
