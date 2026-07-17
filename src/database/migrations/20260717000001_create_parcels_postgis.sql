CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS parcels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT UNIQUE,
  owner_id TEXT,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Polygon, 4326) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS parcels_geom_gist_idx ON parcels USING GIST (geom);
CREATE INDEX IF NOT EXISTS parcels_external_id_idx ON parcels (external_id);
