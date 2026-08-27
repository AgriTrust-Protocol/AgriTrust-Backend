# Backend Documentation

## Overview

Node.js Express API server for the AgriTrust Protocol, providing backend services for trust fund management, milestone verification, and dispute resolution integration.

### 🚀 Key Features

- **Trust Fund Management API:** REST endpoints to create, track, and manage agricultural trust funds.
- **Milestone Verification:** Endpoints to process and verify milestone completion proofs.
- **Dispute & Yield Integrations:** Integrates dispute resolution workflows and monitors treasury yield aggregation.

### 🛠️ Tech Stack

- **Language/Framework:** Node.js / Express
- **Key Dependencies:** `express`, `cors`, `dotenv`

## Getting Started

### Prerequisites

Ensure you have the required toolchains installed:

- Node.js (v18 or higher recommended)
- npm (Node Package Manager)

### Installation & Local Setup

```bash
# Clone the repository (if running manually)
git clone https://github.com/AgriTrust-Protocol/AgriTrust-Backend

# Run the guided onboarding script (checks Node.js, creates .env, installs deps, builds)
npm run onboard

# Start the application
npm start
```

For detailed local setup options, including running tests during onboarding or recreating `.env`, see the Deployment section below.

## Contributing

Contributions are highly welcome. Please ensure your commits are cryptographically signed using GPG or SSH keys. For major structural changes, please open an issue first to discuss your proposal.

## Configuration

The generated `.env` contains safe development defaults for the API port, PostgreSQL, Redis, Stellar/Soroban RPC, and OpenTelemetry endpoint. Update `DATABASE_URL` and `REDIS_URL` if your local services use different credentials, hostnames, or ports.

## API Reference

### POST /api/v1/batches/{id}/certify

Certify a batch and mint a certificate

**Auth required:** Not specified
**Request params/body:**

| Name                     | Type   | Required | Description        |
| ------------------------ | ------ | -------- | ------------------ |
| `id` (path)              | string | yes      | Batch ID           |
| `metadata.source` (body) | string | no       | Source (v1 format) |
| `context.source` (body)  | string | no       | Source (v2 format) |

<!-- TODO: conflict -->

Note: `v1.yaml` specifies the body payload as `metadata.source`, whereas `v2.yaml` specifies it as `context.source`. Both point to the same router path.

**Response (200 OK):**

| Field            | Type   | Description              |
| ---------------- | ------ | ------------------------ |
| `message`        | string | Success message          |
| `certificate_id` | string | ID of minted certificate |

**Errors:**

- `409`: Minting failed or already in progress
- `500`: Internal server error

### Undocumented Endpoints

The following endpoints exist in the codebase but are undocumented in the API specifications:

- `GET /`
- `GET /health/ledger-consistency`
- `GET /metrics`, `GET /metrics/runtime`, `GET /debug/metrics/check`
- `GET /api/versions`
- `GET /openapi.json`
- `GET /api/v1/parcels`, `GET /api/v1/parcels/:id/buffer`, `GET /api/v1/parcels/:id/geometry`
- Admin routes (`/admin/experiments`, `/admin/jobs/*`, `/admin/keys/*`, `/admin/config/*`, `/admin/sagas/*`, `/admin/webhooks/*`)
- Audit routes (`/events`, `/proof`)
- Optimizer routes (`/rebalance`)

## Deployment

Use the onboarding script to make a new workstation or codespace ready for AgriTrust Backend development.

### What the script does

`scripts/onboard-dev.sh` performs the repeatable setup steps needed by contributors:

1. Verifies that `node` and `npm` are available.
2. Enforces the documented minimum Node.js major version of 18.
3. Creates `.env` from `.env.example` without overwriting an existing local file.
4. Installs dependencies with `npm ci` when `package-lock.json` is present.
5. Runs `npm run build` by default so TypeScript issues are caught before development starts.
6. Optionally runs the full test suite.

### Quick start

```bash
npm run onboard
```

To include tests in the first setup pass:

```bash
npm run onboard -- --run-tests
```

### Options

| Option           | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `--skip-install` | Skip dependency installation when `node_modules` is already prepared.  |
| `--skip-build`   | Skip the default TypeScript build check.                               |
| `--run-tests`    | Run `npm test` after setup.                                            |
| `--force-env`    | Recreate `.env` from `.env.example`, replacing the current local file. |
| `-h`, `--help`   | Print usage information.                                               |

## Time-Series Optimization

High-throughput sensor telemetry is stored in the partition-aware
`sensor_readings` table using only vanilla PostgreSQL constructs (no external
TimescaleDB dependency). The optimization layer is defined by the `20260827000001`
migration and the TypeScript managers in `src/db/`:

- **Daily range partitioning** – `sensor_readings` is declaratively partitioned
  `BY RANGE (ts)` into one partition per UTC day; an `AFTER/BEFORE INSERT` trigger
  auto-creates the partition a row belongs to.
- **90-day rolling window** – `detach_sensor_readings_partition()` detaches the
  oldest partition once it is older than 90 days and records it in
  `sensor_readings_archives` so the Parquet export worker can archive it.
- **BRIN + partial GIN indexes** – created per daily partition: a BRIN index
  on `(farm_id, ts)` with `pages_per_range = 128` serves time-range scans, and
  a partial GIN index on `(sensor_type, tags)` serves JSONB metadata queries.
- **Continuous aggregates** – hourly and daily materialized views are refreshed
  every 5 minutes (`sp_refresh_sensor_aggregates()`).
- **Columnar compression** – partitions older than 7 days are converted to the
  `columnar` access method (pg_analytics / Citus) when installed via
  `ColumnarCompression`.
- **Auto-vacuum tuning** – `autovacuum_vacuum_scale_factor = 0.01` with a
  threshold of 1000 rows is applied to the hot write path.

To exercise the 500K rows/hour write target and the aggregate query budgets:

```bash
DATABASE_URL=postgres://user:pass@host/db npm run benchmark:timeseries
```

See [docs/operations/time-series-optimization.md](docs/operations/time-series-optimization.md)
for the full guide.
