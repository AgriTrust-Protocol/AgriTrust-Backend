# Backend Documentation

## Overview

Node.js Express API server for the AgriTrust Protocol, providing backend services for trust fund management, milestone verification, and dispute resolution integration.

### 🚀 Key Features
* **Trust Fund Management API:** REST endpoints to create, track, and manage agricultural trust funds.
* **Milestone Verification:** Endpoints to process and verify milestone completion proofs.
* **Dispute & Yield Integrations:** Integrates dispute resolution workflows and monitors treasury yield aggregation.

### 🛠️ Tech Stack
* **Language/Framework:** Node.js / Express
* **Key Dependencies:** `express`, `cors`, `dotenv`

## Getting Started

### Prerequisites
Ensure you have the required toolchains installed:
* Node.js (v18 or higher recommended)
* npm (Node Package Manager)

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
| Name | Type | Required | Description |
|---|---|---|---|
| `id` (path) | string | yes | Batch ID |
| `metadata.source` (body) | string | no | Source (v1 format) |
| `context.source` (body) | string | no | Source (v2 format) |

<!-- TODO: conflict -->
Note: `v1.yaml` specifies the body payload as `metadata.source`, whereas `v2.yaml` specifies it as `context.source`. Both point to the same router path.

**Response (200 OK):**
| Field | Type | Description |
|---|---|---|
| `message` | string | Success message |
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
| Option | Purpose |
| --- | --- |
| `--skip-install` | Skip dependency installation when `node_modules` is already prepared. |
| `--skip-build` | Skip the default TypeScript build check. |
| `--run-tests` | Run `npm test` after setup. |
| `--force-env` | Recreate `.env` from `.env.example`, replacing the current local file. |
| `-h`, `--help` | Print usage information. |

