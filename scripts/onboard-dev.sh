#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUN_TESTS=0
RUN_BUILD=1
INSTALL_DEPS=1
FORCE_ENV=0
PACKAGE_MANAGER="npm"

usage() {
  cat <<'USAGE'
Usage: scripts/onboard-dev.sh [options]

Bootstraps a local AgriTrust Backend development environment.

Options:
  --skip-install      Do not install npm dependencies.
  --skip-build        Do not run the TypeScript build check.
  --run-tests         Run the test suite after setup.
  --force-env         Overwrite .env from .env.example.
  -h, --help          Show this help message.
USAGE
}

log() { printf '\033[1;34m[onboard]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[onboard:warn]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[onboard:error]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install) INSTALL_DEPS=0 ;;
    --skip-build) RUN_BUILD=0 ;;
    --run-tests) RUN_TESTS=1 ;;
    --force-env) FORCE_ENV=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' was not found in PATH."
}

version_major() {
  "$1" --version | sed -E 's/^v?([0-9]+).*/\1/'
}

log "Checking required local toolchain."
require_command node
require_command npm
NODE_MAJOR="$(version_major node)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  fail "Node.js v18 or newer is required; found $(node --version)."
fi
log "Node $(node --version) and npm $(npm --version) detected."

if [[ ! -f package.json ]]; then
  fail "package.json was not found. Run this script from the repository checkout."
fi

if [[ -f .env && "$FORCE_ENV" -eq 0 ]]; then
  log ".env already exists; leaving it unchanged."
else
  [[ -f .env.example ]] || fail ".env.example is missing."
  cp .env.example .env
  log "Created .env from .env.example. Review service URLs before starting the app."
fi

if [[ "$INSTALL_DEPS" -eq 1 ]]; then
  if [[ -f package-lock.json ]]; then
    log "Installing dependencies with npm ci."
    "$PACKAGE_MANAGER" ci
  else
    warn "package-lock.json missing; falling back to npm install."
    "$PACKAGE_MANAGER" install
  fi
else
  warn "Skipping dependency installation."
fi

if [[ "$RUN_BUILD" -eq 1 ]]; then
  log "Running TypeScript build check."
  "$PACKAGE_MANAGER" run build
else
  warn "Skipping build check."
fi

if [[ "$RUN_TESTS" -eq 1 ]]; then
  log "Running test suite."
  "$PACKAGE_MANAGER" test
fi

cat <<'NEXT_STEPS'

Local setup complete.
Next steps:
  1. Review .env and point DATABASE_URL/REDIS_URL at your local services.
  2. Run npm start to launch the API.
  3. Run npm test before opening a pull request.
NEXT_STEPS
