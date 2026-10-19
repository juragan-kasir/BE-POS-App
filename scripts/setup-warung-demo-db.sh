#!/usr/bin/env bash
set -euo pipefail

# Creates a DEDICATED local demo database cloned schema-only from the dev DB.
# It never writes to, truncates, or drops the source database.

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
  echo "[warung-demo-db] REFUSED: $*" >&2
  exit 1
}

[[ "${NODE_ENV_VALUE}" == "production" || "${NODE_ENV_VALUE}" == "staging" ]] && \
  fail "NODE_ENV=${NODE_ENV_VALUE} is not a demo environment"
[[ "${DEMO_DB}" =~ ^[A-Za-z0-9_]+$ ]] || fail "invalid demo database name"
[[ "${DEMO_DB}" =~ demo ]] || fail "demo database name must contain 'demo'"
[[ "${DEMO_DB}" != "${SOURCE_DB}" ]] || fail "demo database must differ from the dev database (${SOURCE_DB})"
[[ "${DEMO_DB}" != "cashier_app" ]] || fail "refusing to use the real dev database"

if ! pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" >/dev/null 2>&1; then
  fail "PostgreSQL is not reachable at ${DB_HOST}:${DB_PORT}"
fi

echo "[warung-demo-db] source schema: ${SOURCE_DB} (read-only)"
echo "[warung-demo-db] demo database: ${DEMO_DB}"

if ! psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${DEMO_DB}'" | grep -q 1; then
  createdb -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" "${DEMO_DB}"
  echo "[warung-demo-db] created ${DEMO_DB}"
fi

TABLE_COUNT="$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DEMO_DB}" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
if [[ "${TABLE_COUNT}" == "0" ]]; then
  echo "[warung-demo-db] cloning schema from ${SOURCE_DB}"
  pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" \
    --schema-only --no-owner --no-privileges "${SOURCE_DB}" \
    | psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DEMO_DB}" >/dev/null
else
  echo "[warung-demo-db] schema already present (${TABLE_COUNT} tables); leaving it intact"
fi

cat <<EOF

[warung-demo-db] Ready: ${DEMO_DB}
[warung-demo-db] No real data was copied and ${SOURCE_DB} was not modified.

Seed the demo fixtures (choose a local-only password):
  DB_DEV_DATABASE=${DEMO_DB} \\
  WARUNG_DEMO_CONFIRM=${DEMO_DB} \\
  WARUNG_DEMO_ADMIN_PASSWORD='<local-demo-password>' \\
  node scripts/seed-warung-demo.js

Then run the backend against the demo DB:
  DB_DEV_DATABASE=${DEMO_DB} npm run dev
EOF
