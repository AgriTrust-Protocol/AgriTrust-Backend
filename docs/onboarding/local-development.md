# Local Development Onboarding

Use the onboarding script to make a new workstation or codespace ready for AgriTrust Backend development.

## What the script does

`scripts/onboard-dev.sh` performs the repeatable setup steps needed by contributors:

1. Verifies that `node` and `npm` are available.
2. Enforces the documented minimum Node.js major version of 18.
3. Creates `.env` from `.env.example` without overwriting an existing local file.
4. Installs dependencies with `npm ci` when `package-lock.json` is present.
5. Runs `npm run build` by default so TypeScript issues are caught before development starts.
6. Optionally runs the full test suite.

## Quick start

```bash
npm run onboard
```

To include tests in the first setup pass:

```bash
npm run onboard -- --run-tests
```

## Options

| Option | Purpose |
| --- | --- |
| `--skip-install` | Skip dependency installation when `node_modules` is already prepared. |
| `--skip-build` | Skip the default TypeScript build check. |
| `--run-tests` | Run `npm test` after setup. |
| `--force-env` | Recreate `.env` from `.env.example`, replacing the current local file. |
| `-h`, `--help` | Print usage information. |

## Local service configuration

The generated `.env` contains safe development defaults for the API port, PostgreSQL, Redis, Stellar/Soroban RPC, and OpenTelemetry endpoint. Update `DATABASE_URL` and `REDIS_URL` if your local services use different credentials, hostnames, or ports.
