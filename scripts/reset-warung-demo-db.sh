#!/usr/bin/env bash
set -euo pipefail

# Drops and recreates ONLY the dedicated local demo database, then clones the
# schema again. It cannot touch the dev/test/production databases because the
# name is validated before any destructive command runs.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

DEMO_DB="${WARUNG_DEMO_DATABASE:-cashier_app_warung_demo}"
SOURCE_DB="${DB_DEV_DATABASE:-cashier_app}"
DB_HOST="${DB_DEV_HOST:-127.0.0.1}"
DB_PORT="${DB_DEV_PORT:-5432}"
DB_USER="${DB_DEV_USERNAME:-postgres}"
DB_PASS="${DB_DEV_PASSWORD:-}"
NODE_ENV_VALUE="${NODE_ENV:-development}"

export PGPASSWORD="${DB_PASS}"

fail() {
  echo "[warung-demo-reset] REFUSED: $*" >&2
  exit 1
}

[[ "${NODE_ENV_VALUE}" == "production" || "${NODE_ENV_VALUE}" == "staging" ]] && \
  fail "NODE_ENV=${NODE_ENV_VALUE} is not a demo environment"
[[ "${DEMO_DB}" =~ ^[A-Za-z0-9_]+$ ]] || fail "invalid demo database name"
[[ "${DEMO_DB}" =~ demo ]] || fail "demo database name must contain 'demo'"
[[ "${DEMO_DB}" != "${SOURCE_DB}" ]] || fail "demo database must differ from the dev database (${SOURCE_DB})"
[[ "${DEMO_DB}" != "cashier_app" ]] || fail "refusing to drop the real dev database"
[[ "${WARUNG_DEMO_CONFIRM:-}" == "${DEMO_DB}" ]] || \
  fail "set WARUNG_DEMO_CONFIRM=${DEMO_DB} to confirm the drop of this dedicated demo database"

echo "[warung-demo-reset] dropping dedicated demo database: ${DEMO_DB}"
dropdb -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" --if-exists "${DEMO_DB}"

WARUNG_DEMO_DATABASE="${DEMO_DB}" \
  DB_DEV_DATABASE="${SOURCE_DB}" \
  DB_DEV_HOST="${DB_HOST}" \
  DB_DEV_PORT="${DB_PORT}" \
  DB_DEV_USERNAME="${DB_USER}" \
  DB_DEV_PASSWORD="${DB_PASS}" \
  bash "${SCRIPT_DIR}/setup-warung-demo-db.sh"

cat <<EOF

[warung-demo-reset] ${DEMO_DB} is empty (schema only). Re-seed with:
  DB_DEV_DATABASE=${DEMO_DB} \\
  WARUNG_DEMO_CONFIRM=${DEMO_DB} \\
  WARUNG_DEMO_ADMIN_PASSWORD='<local-demo-password>' \\
  node scripts/seed-warung-demo.js
EOF
