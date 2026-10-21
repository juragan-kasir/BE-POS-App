'use strict'

/**
 * Phase 33 Batch 2 (F-02) — migration chain validator.
 *
 * Proves the repository migration chain executes from its documented
 * baseline on a disposable database:
 *
 *   1. create ephemeral DB (name-gated, localhost/service only)
 *   2. load scripts/dev-schema.sql (the documented snapshot baseline —
 *      the chain is intentionally incremental and cannot bootstrap empty)
 *   3. stamp SequelizeMeta with db/migration-baseline.txt (migrations whose
 *      effects the snapshot already embodies — the explicit provenance
 *      boundary; everything else MUST execute below)
 *   4. run `sequelize-cli db:migrate` through the normal CLI
 *   5. verify meta == file set (count, membership, order, no duplicates)
 *   6. verify remediation-era schema invariants
 *   7. drop the ephemeral DB (success and failure paths)
 *
 * Safety: refuses to run unless the target host is a local/CI Postgres
 * service AND the database name matches the ephemeral pattern AND no
 * production-adjacent env vars are present. Never touches cashier_app,
 * cashier_app_test, Neon, or anything else.
 *
 * Usage:
 *   VALIDATION_DB=cashier_app_migration_validation node scripts/validate-migration-chain.js
 * Connection (defaults mirror scripts/setup-test-db.js):
 *   PGHOST (or DB_DEV_HOST) default 127.0.0.1
 *   PGPORT (or DB_DEV_PORT) default 5432
 *   PGUSER (or DB_DEV_USERNAME) default postgres
 *   PGPASSWORD (or DB_DEV_PASSWORD), no default
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const ROOT = path.join(__dirname, '..')
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations')
const MANIFEST_PATH = path.join(ROOT, 'db', 'migration-baseline.txt')
const SNAPSHOT_PATH = path.join(ROOT, 'scripts', 'dev-schema.sql')

const DB_NAME_PATTERN = /^cashier_app_migration_validation[a-z0-9_]*$/
const PROTECTED_NAMES = new Set([
  'cashier_app',
  'cashier_app_test',
  'postgres',
  'template0',
  'template1',
  'neondb',
  'verceldb'
])
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres'])
const PROD_ENV_VARS = [
  'POSTGRES_HOST',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DATABASE',
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL_NO_SSL',
  'DATABASE_URL',
  'NEON_API_KEY'
]

const log = (msg) => console.log(`[chain-validation] ${msg}`)
const fail = (msg) => {
  console.error(`[chain-validation] FAIL: ${msg}`)
  process.exitCode = 1
  throw new Error(msg)
}

function pgEnv() {
  return {
    PGHOST: process.env.PGHOST || process.env.DB_DEV_HOST || '127.0.0.1',
    PGPORT: process.env.PGPORT || process.env.DB_DEV_PORT || '5432',
    PGUSER: process.env.PGUSER || process.env.DB_DEV_USERNAME || 'postgres',
    PGPASSWORD: process.env.PGPASSWORD || process.env.DB_DEV_PASSWORD || ''
  }
}

function safetyGate(dbName, pg) {
  if (!dbName) fail('VALIDATION_DB env var is required (e.g. cashier_app_migration_validation)')
  if (!DB_NAME_PATTERN.test(dbName)) {
    fail(`refusing: database name "${dbName}" does not match ephemeral pattern ${DB_NAME_PATTERN}`)
  }
  if (PROTECTED_NAMES.has(dbName)) fail(`refusing: "${dbName}" is a protected database name`)
  if (!ALLOWED_HOSTS.has(pg.PGHOST)) {
    fail(`refusing: host "${pg.PGHOST}" is not a local/CI Postgres service`)
  }
  for (const v of PROD_ENV_VARS) {
    if (process.env[v]) fail(`refusing: production-adjacent env var ${v} is set in this process`)
  }
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    env: { ...process.env, PGPASSWORD: pgEnv().PGPASSWORD },
    encoding: 'utf8',
    ...opts
  })
  if (res.status !== 0) {
    fail(`${cmd} ${args.join(' ')} exited ${res.status}: ${(res.stderr || res.stdout || '').slice(-2000)}`)
  }
  return res.stdout
}

async function query(pg, dbName, sql) {
  const client = new Client({
    host: pg.PGHOST,
    port: Number(pg.PGPORT),
    user: pg.PGUSER,
    password: pg.PGPASSWORD || undefined,
    database: dbName
  })
  await client.connect()
  try {
    const res = await client.query(sql)
    return res.rows
  } finally {
    await client.end()
  }
}

function readManifest() {
  const lines = fs
    .readFileSync(MANIFEST_PATH, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const dups = lines.filter((l, i) => lines.indexOf(l) !== i)
  if (dups.length > 0) fail(`manifest contains duplicates: ${[...new Set(dups)].join(', ')}`)
  return lines
}

function discoverFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
}

// Step-8 remediation-era invariants: [label, sql, expectedFn(rows)->{ok, detail}]
function invariants() {
  return [
    {
      label: 'order monetary BIGINT',
      sql: `SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema='public' AND table_name='order'
            AND column_name IN ('subTotal','discountAmount','taxAmount','serviceChargeAmount','totalPrice')`,
      check: (rows) =>
        rows.length === 5 && rows.every((r) => r.data_type === 'bigint')
          ? null
          : `expected 5 bigint columns, got ${JSON.stringify(rows)}`
    },
    {
      label: 'transaction/order_item monetary BIGINT',
      sql: `SELECT table_name, column_name, data_type FROM information_schema.columns
            WHERE table_schema='public' AND ((table_name='transaction' AND column_name IN ('amount','cashReceived','changeGiven'))
            OR (table_name='order_item' AND column_name IN ('price','discountAmount','totalPrice')))`,
      check: (rows) =>
        rows.length === 6 && rows.every((r) => r.data_type === 'bigint')
          ? null
          : `expected 6 bigint columns, got ${JSON.stringify(rows)}`
    },
    {
      label: 'purchase monetary BIGINT',
      sql: `SELECT table_name, column_name, data_type FROM information_schema.columns
            WHERE table_schema='public' AND ((table_name='purchase_order' AND column_name IN ('totalAmount','discount','finalAmount','taxAmount'))
            OR (table_name='purchase_order_item' AND column_name IN ('price','total'))
            OR (table_name='purchase_payment' AND column_name='amount')
            OR (table_name='goods_receipt_item' AND column_name IN ('costPrice','landedCost')))`,
      check: (rows) =>
        rows.length === 9 && rows.every((r) => r.data_type === 'bigint')
          ? null
          : `expected 9 bigint columns, got ${JSON.stringify(rows)}`
    },
    {
      label: 'goods_receipt_item.qtyReceived NUMERIC(10,4)',
      sql: `SELECT data_type, numeric_precision, numeric_scale, is_nullable FROM information_schema.columns
            WHERE table_schema='public' AND table_name='goods_receipt_item' AND column_name='qtyReceived'`,
      check: (rows) =>
        rows.length === 1 &&
        rows[0].data_type === 'numeric' &&
        Number(rows[0].numeric_precision) === 10 &&
        Number(rows[0].numeric_scale) === 4
          ? null
          : `expected numeric(10,4), got ${JSON.stringify(rows)}`
    },
    {
      label: 'fractional stock NUMERIC(10,4)',
      sql: `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns
            WHERE table_schema='public' AND ((table_name IN ('product','ingredient','product_store_stock') AND column_name='stock')
            OR (table_name='stock_history' AND column_name IN ('quantityBefore','quantityChange','quantityAfter')))`,
      check: (rows) =>
        rows.length === 6 &&
        rows.every(
          (r) =>
            r.data_type === 'numeric' &&
            Number(r.numeric_precision) === 10 &&
            Number(r.numeric_scale) === 4
        )
          ? null
          : `expected 6 numeric(10,4) columns, got ${JSON.stringify(rows)}`
    },
    {
      label: 'goods_receipt idempotency column + partial unique index',
      sql: `SELECT
              (SELECT count(*)::int FROM information_schema.columns
               WHERE table_schema='public' AND table_name='goods_receipt' AND column_name='idempotencyKey') AS col,
              (SELECT indexdef FROM pg_indexes WHERE indexname='goods_receipt_po_idempotency_unique') AS idx`,
      check: (rows) => {
        const { col, idx } = rows[0] || {}
        if (Number(col) !== 1) return 'idempotencyKey column missing'
        if (!idx || !idx.includes('"purchaseOrderId"') || !idx.includes('"idempotencyKey"') || !/WHERE/i.test(idx)) {
          return `partial unique index wrong or missing: ${idx}`
        }
        return null
      }
    },
    {
      label: 'non-negative stock CHECK constraints',
      sql: `SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint
            WHERE contype='c' AND conrelid::regclass::text IN ('product','product_store_stock')
            AND conname IN ('product_stock_non_negative','product_store_stock_stock_non_negative')`,
      check: (rows) => (rows.length === 2 ? null : `expected 2 CHECKs, got ${JSON.stringify(rows)}`)
    },
    {
      label: 'product_review deviceId column + partial unique index',
      sql: `SELECT
              (SELECT data_type FROM information_schema.columns
               WHERE table_schema='public' AND table_name='product_review' AND column_name='deviceId') AS coltype,
              (SELECT count(*)::int FROM pg_indexes WHERE indexname='uq_product_review_device') AS idxcount,
              (SELECT indexdef FROM pg_indexes WHERE indexname='uq_product_review_device') AS idx`,
      check: (rows) => {
        const { coltype, idxcount, idx } = rows[0] || {}
        if (!coltype) return 'deviceId column missing on product_review'
        if (coltype !== 'character varying') return `deviceId wrong type: ${coltype}`
        if (Number(idxcount) !== 1) {
          return `uq_product_review_device expected exactly once, found ${idxcount}`
        }
        if (!idx || !idx.includes('"productId"') || !idx.includes('"deviceId"')) {
          return `partial unique index wrong columns: ${idx}`
        }
        const norm = idx.replace(/\s+/g, ' ').replace(/[()"]/g, '')
        if (!/WHERE/i.test(idx) || !/deviceId IS NOT NULL/i.test(norm)) {
          return `partial unique index predicate wrong or missing: ${idx}`
        }
        return null
      }
    }
  ]
}

async function main() {
  const dbName = process.env.VALIDATION_DB
  const pg = pgEnv()
  safetyGate(dbName, pg)
  log(`target host=${pg.PGHOST} db=${dbName} (ephemeral, local/CI only)`)

  const dropDb = () => {
    if (!DB_NAME_PATTERN.test(dbName) || PROTECTED_NAMES.has(dbName)) {
      throw new Error('cleanup refused: database name failed safety re-check')
    }
    run('dropdb', ['-h', pg.PGHOST, '-p', pg.PGPORT, '-U', pg.PGUSER, '--if-exists', dbName])
  }

  try {
    // 1. Fresh ephemeral database.
    dropDb()
    run('createdb', ['-h', pg.PGHOST, '-p', pg.PGPORT, '-U', pg.PGUSER, dbName])
    log('ephemeral database created')

    // 2. Documented snapshot baseline (NOT the object under test).
    if (!fs.existsSync(SNAPSHOT_PATH)) fail(`snapshot not found: ${SNAPSHOT_PATH}`)
    run('psql', ['-h', pg.PGHOST, '-p', pg.PGPORT, '-U', pg.PGUSER, '-d', dbName, '-q', '-f', SNAPSHOT_PATH])
    log('snapshot baseline loaded')

    // 3. Stamp the manifest boundary; everything else must execute.
    const manifest = readManifest()
    const files = discoverFiles()
    const fileSet = new Set(files)
    for (const name of manifest) {
      if (!fileSet.has(name)) fail(`manifest entry has no migration file: ${name}`)
    }
    const pending = files.filter((f) => !manifest.includes(f))
    log(`manifest=${manifest.length} files=${files.length} pending=${pending.length} (${pending.join(', ') || 'none'})`)

    const values = manifest.map((n) => `('${n.replace(/'/g, "''")}')`).join(',')
    await query(pg, dbName, `INSERT INTO "SequelizeMeta" (name) VALUES ${values}`)
    log('baseline history stamped')

    // 4. Execute through the normal CLI (must run the pending tail).
    const out = run(
      'npx',
      ['sequelize-cli', 'db:migrate'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DB_TEST_DATABASE: dbName,
          DB_DEV_HOST: pg.PGHOST,
          DB_DEV_PORT: pg.PGPORT,
          DB_DEV_USERNAME: pg.PGUSER,
          DB_DEV_PASSWORD: pg.PGPASSWORD
        }
      }
    )
    const migrated = (out.match(/migrated \(\d/g) || []).length
    log(`db:migrate exit 0, migrated count=${migrated}`)

    // 5. Ledger assertions: file set == meta set, ordered, no duplicates.
    const metaRows = await query(pg, dbName, 'SELECT name FROM "SequelizeMeta" ORDER BY name')
    const metaNames = metaRows.map((r) => r.name)
    if (metaNames.length !== files.length) {
      fail(`meta/file count mismatch: meta=${metaNames.length} files=${files.length}`)
    }
    const missing = files.filter((f) => !metaNames.includes(f))
    if (missing.length > 0) fail(`meta missing entries: ${missing.join(', ')}`)
    const orphans = metaNames.filter((m) => !fileSet.has(m))
    if (orphans.length > 0) fail(`meta orphan entries: ${orphans.join(', ')}`)
    const dupes = metaNames.filter((m, i) => metaNames.indexOf(m) !== i)
    if (dupes.length > 0) fail(`duplicate meta entries: ${[...new Set(dupes)].join(', ')}`)
    const sorted = [...metaNames].sort()
    if (JSON.stringify(sorted) !== JSON.stringify(metaNames)) fail('meta ordering inconsistent')
    log(`ledger OK: ${metaNames.length}/${files.length} recorded exactly once, in order`)

    // 6. Schema invariants.
    let failed = 0
    const allInvariants = invariants()
    for (const inv of allInvariants) {
      const rows = await query(pg, dbName, inv.sql)
      const problem = inv.check(rows)
      if (problem) {
        failed += 1
        console.error(`[chain-validation] INVARIANT FAIL ${inv.label}: ${problem}`)
      } else {
        log(`invariant OK: ${inv.label}`)
      }
    }
    if (failed > 0) fail(`${failed} schema invariant(s) failed`)

    // 7. Target-identity sanity: still the ephemeral DB, never anything else.
    const ident = await query(pg, dbName, 'SELECT current_database() AS db')
    if (ident[0].db !== dbName) fail(`target identity drift: connected to ${ident[0].db}`)
    log(`PASS: chain validated on ${dbName} (${files.length} files, ${migrated} executed, ${allInvariants.length} invariants green)`)
  } finally {
    try {
      dropDb()
      log('ephemeral database dropped')
    } catch (cleanupErr) {
      console.error(`[chain-validation] cleanup warning: ${cleanupErr.message}`)
    }
  }
}

if (require.main === module) {
  main().catch(() => {
    if (!process.exitCode) process.exitCode = 1
  })
}

module.exports = { DB_NAME_PATTERN, PROTECTED_NAMES, ALLOWED_HOSTS }
