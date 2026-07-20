-- AgriTrust Protocol – Migration Rollback Journal Table
-- Backs the phantom-read-safe migration runner (issue #40).
--
-- _migration_journal: one row per applied migration, holding:
--   id              – surrogate primary key
--   checksum        – MD5 of the migration file path (idempotency guard)
--   version         – YYYYMMDD_HHMMSS version extracted from the filename
--   name            – human-readable description from the filename
--   applied_at      – wall-clock timestamp of successful application
--   undo_sql        – undo block (sentinel ref or raw SQL); must be < 1 MB
--   affected_tables – table names locked during application
--   rolled_back_at  – set when the migration is rolled back (soft-delete)

-- migrate:up
CREATE TABLE IF NOT EXISTS _migration_journal (
    id               BIGSERIAL    PRIMARY KEY,
    checksum         TEXT         NOT NULL,
    version          TEXT         NOT NULL,
    name             TEXT         NOT NULL,
    applied_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    undo_sql         TEXT         NOT NULL,
    affected_tables  TEXT[]       NOT NULL DEFAULT '{}',
    rolled_back_at   TIMESTAMPTZ
);

-- Enforces at-most-one active entry per version.
CREATE UNIQUE INDEX IF NOT EXISTS idx_migration_journal_version
    ON _migration_journal (version)
    WHERE rolled_back_at IS NULL;

-- Ordered lookups for rollbackTo() (most recent first).
CREATE INDEX IF NOT EXISTS idx_migration_journal_applied_at
    ON _migration_journal (applied_at DESC)
    WHERE rolled_back_at IS NULL;

-- migrate:down
DROP TABLE IF EXISTS _migration_journal;
