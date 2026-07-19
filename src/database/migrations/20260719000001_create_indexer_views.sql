CREATE TABLE IF NOT EXISTS raw_events (
  chain TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  event_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain, transaction_hash, log_index)
);

CREATE TABLE IF NOT EXISTS indexer_cursors (
  chain TEXT PRIMARY KEY,
  last_block BIGINT NOT NULL,
  block_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS farm_yields (
  event_id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  season TEXT,
  crop TEXT,
  quantity NUMERIC,
  unit TEXT,
  block_number BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_farm_yields_farm_season ON farm_yields(farm_id, season);
CREATE INDEX IF NOT EXISTS idx_farm_yields_tx ON farm_yields(transaction_hash);

CREATE TABLE IF NOT EXISTS settlements (
  event_id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  season TEXT,
  amount NUMERIC,
  asset TEXT,
  counterparty TEXT,
  block_number BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlements_farm_season ON settlements(farm_id, season);
CREATE INDEX IF NOT EXISTS idx_settlements_tx ON settlements(transaction_hash);

CREATE TABLE IF NOT EXISTS provenance_events (
  event_id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  season TEXT,
  provenance_hash TEXT,
  metadata JSONB NOT NULL,
  block_number BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provenance_events_farm_season ON provenance_events(farm_id, season);
CREATE INDEX IF NOT EXISTS idx_provenance_events_tx ON provenance_events(transaction_hash);

CREATE TABLE IF NOT EXISTS insurance_claims (
  event_id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  season TEXT,
  claim_id TEXT,
  status TEXT,
  amount NUMERIC,
  block_number BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insurance_claims_farm_season ON insurance_claims(farm_id, season);
CREATE INDEX IF NOT EXISTS idx_insurance_claims_tx ON insurance_claims(transaction_hash);
