'use strict'

/**
 * W-02R.4 — ephemeral staging rehearsal harness (Model D preserved).
 *
 * Rehearses the production migration remediation against a DISPOSABLE local
 * PostgreSQL database. Nothing here contacts production or staging-shared
 * infrastructure: the rehearsal database is created by this harness, used
 * once, and dropped. Production behavior of every W-01.1 module is unchanged.
 *
 * Lifecycle (fixed order, no partial modes):
 *   validate (file-level, no DB touch)
 *     → create ephemeral DB
 *     → identity guard (name pattern + local host + connected DB check)
 *     → S0 baseline capture (read-only)
 *     → S1 snapshot load + synthetic drift fixture (staging writes only)
 *     → S2 disposition stamping (INSERT-only, approved manifest + SHA)
 *     → S3 controlled applies (missing effects only, never whole files)
 *     → S4 E2 migrations through the real sequelize-cli runner (timed)
 *     → S5/S6 verification (accounting + schema + data + non-execution)
 *     → S7 evidence bundle
 *     → cleanup (DROP DATABASE; kept only with --keep-on-failure on failure)
 *
 * Safety contract:
 *   - DRY-RUN BY DEFAULT. Without --apply only file-level validation runs;
 *     no database is created, connected, or mutated.
 *   - Mutation requires ALL of: --staging-db=<rehearsal name>,
 *     --manifest=<staging manifest> (default: the rehearsal manifest),
 *     --apply, --authorize-manifest-sha256=<sha256 of the exact manifest
 *     file bytes>, and an APPROVED manifest. Approval is never populated
 *     by this harness; the operator reviews and approves the file first.
 *   - Staging reads ONLY STAGING_DB_* variables. Production variables
 *     (POSTGRES_*), .env.production, and the production manifest are never
 *     consulted for staging actions; crossover combinations fail closed.
 *   - The rehearsal database name must match REHEARSAL_DB_PATTERN and the
 *     host must be local. Anything else is refused before any mutation.
 *   - Rollback for controlled index operations is DROP INDEX; for the
 *     split_bill NOT NULL it is DROP NOT NULL. Migration down() methods
 *     that drop tables are NEVER used as rollback. Teardown (DROP DATABASE)
 *     is the final cleanup boundary.
 *   - Evidence never contains passwords, connection strings, or secrets.
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const rules = require('./migration-dispositions')
const stamper = require('./apply-migration-dispositions')
const preflight = require('./check-migration-preflight')
const verifier = require('./check-production-schema')

const ROOT = path.join(__dirname, '..')
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations')
const SNAPSHOT_PATH = path.join(ROOT, 'scripts', 'dev-schema.sql')
const DEFAULT_EVIDENCE_DIR = path.join(ROOT, 'docs', 'superpowers', 'evidence')

// Repository precedent: scripts/validate-migration-chain.js restricts its
// disposable database to /^cashier_app_migration_validation[a-z0-9_]*$/.
// The rehearsal database follows the same discipline with its own prefix so
// the two can never collide — and production names can never match.
const REHEARSAL_DB_PATTERN = /^cashier_app_staging_rehearsal[a-z0-9_]*$/
const MAINTENANCE_DB = 'postgres'

// Locked accounting model (W-02R.4 discovery): any repository growth forces
// a manifest review instead of silently changing the rehearsal.
const EXPECTED_REPO_MIGRATIONS = 241
const EXPECTED_MANIFEST_ROWS = 197
const EXPECTED_LEDGER_ROWS = 26
const EXPECTED_E2_COUNT = 18

// November foundation migrations (part of the 26 production ledger rows).
// SCHEMA ONLY, additive, safe to execute against the snapshot baseline via
// their real up() functions during fixture construction.
const NOVEMBER_FOUNDATION_MIGRATIONS = Object.freeze([
  '20261008000001-create-auth-foundation.js',
  '20261009000001-create-authorization-context-session.js',
  '20261009000002-enforce-store-tenant-lifecycle.js',
  '20261010000001-add-disabled-at-to-user.js'
])

// Snapshot-converged numeric columns the drift fixture reverts to INTEGER
// (guarded: only altered when currently DECIMAL/NUMERIC) so the E2 decimal
// migrations have real work to converge.
const DRIFT_INTEGER_TARGETS = Object.freeze([
  { table: 'product', column: 'stock' },
  { table: 'ingredient', column: 'stock' },
  { table: 'product_store_stock', column: 'stock' },
  { table: 'stock_history', column: 'quantityBefore' },
  { table: 'stock_history', column: 'quantityChange' },
  { table: 'stock_history', column: 'quantityAfter' },
  { table: 'goods_receipt_item', column: 'qtyReceived' }
])

const REGION_INDEXES = Object.freeze([
  { name: 'region_code_unique', columns: ['code'], unique: true },
  { name: 'region_level_idx', columns: ['level'], unique: false },
  { name: 'region_parent_code_idx', columns: ['parentCode'], unique: false }
])
const PRODUCT_REVIEW_INDEXES = Object.freeze([
  { name: 'product_review_product_store', columns: ['productId', 'store'], unique: false },
  { name: 'product_review_store', columns: ['store'], unique: false }
])

class RehearsalRefusedError extends Error {
  constructor(message) {
    super(`[rehearse-staging] REFUSED: ${message}`)
    this.name = 'RehearsalRefusedError'
  }
}

function discoverMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()
}

// CLI parsing. Unknown flags are refused (fail closed).
function parseArgs(argv) {
  const opts = {
    stagingDb: null,
    manifestPath: rules.STAGING_DISPOSITIONS_PATH,
    apply: false,
    authorizeSha256: null,
    keepOnFailure: false,
    evidenceDir: DEFAULT_EVIDENCE_DIR
  }
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true
    else if (arg === '--keep-on-failure') opts.keepOnFailure = true
    else if (arg.startsWith('--staging-db=')) opts.stagingDb = arg.slice('--staging-db='.length)
    else if (arg.startsWith('--manifest=')) opts.manifestPath = arg.slice('--manifest='.length)
    else if (arg.startsWith('--authorize-manifest-sha256=')) {
      opts.authorizeSha256 = arg.slice('--authorize-manifest-sha256='.length)
    } else if (arg.startsWith('--evidence-dir=')) {
      opts.evidenceDir = arg.slice('--evidence-dir='.length)
    } else throw new RehearsalRefusedError(`unknown argument "${arg}"`)
  }
  if (!opts.stagingDb) throw new RehearsalRefusedError('--staging-db=<rehearsal database name> is required (no default)')
  if (opts.authorizeSha256 && !opts.apply) {
    throw new RehearsalRefusedError('--authorize-manifest-sha256 is only meaningful with --apply')
  }
  if (opts.apply && !/^[0-9a-f]{64}$/.test(opts.authorizeSha256 || '')) {
    throw new RehearsalRefusedError('--apply requires --authorize-manifest-sha256=<64-hex sha256 of the manifest file>')
  }
  return opts
}

// Pure target-identity guard. Refuses anything that is not an explicitly
// named local ephemeral rehearsal database, and any crossover with the
// configured production database. Called BEFORE any mutation.
function assertRehearsalTarget({ database, host, prodDatabase }) {
  if (!database || !REHEARSAL_DB_PATTERN.test(database)) {
    throw new RehearsalRefusedError(
      `rehearsal database "${database || '(unset)'}" does not match the ephemeral pattern ${REHEARSAL_DB_PATTERN}`
    )
  }
  if (!preflight.LOCAL_HOSTS.includes(String(host || '').toLowerCase())) {
    throw new RehearsalRefusedError(`rehearsal host "${host || '(unset)'}" is not local; remote rehearsal targets are refused`)
  }
  if (prodDatabase && database === prodDatabase) {
    throw new RehearsalRefusedError('rehearsal database must not be the production database (crossover refused)')
  }
  return { database, host }
}

// Pure accounting derivation. E2 is DERIVED (files minus manifest minus
// fixture ledger), never hardcoded; locked counts fail closed on drift.
function deriveRehearsalSets({ files, manifestNames, fixtureLedgerNames }) {
  const manifestSet = new Set(manifestNames)
  const ledgerSet = new Set(fixtureLedgerNames)
  for (const n of manifestNames) {
    if (!files.includes(n)) throw new RehearsalRefusedError(`manifest row has no repository file: ${n}`)
  }
  for (const n of fixtureLedgerNames) {
    if (!files.includes(n)) throw new RehearsalRefusedError(`fixture ledger row has no repository file: ${n}`)
    if (manifestSet.has(n)) throw new RehearsalRefusedError(`fixture ledger row must not be dispositioned: ${n}`)
  }
  const e2 = files.filter((f) => !manifestSet.has(f) && !ledgerSet.has(f))
  if (files.length !== EXPECTED_REPO_MIGRATIONS) {
    throw new RehearsalRefusedError(`repository migrations ${files.length} != expected ${EXPECTED_REPO_MIGRATIONS}; review the manifest first`)
  }
  if (manifestNames.length !== EXPECTED_MANIFEST_ROWS) {
    throw new RehearsalRefusedError(`manifest rows ${manifestNames.length} != expected ${EXPECTED_MANIFEST_ROWS}`)
  }
  if (fixtureLedgerNames.length !== EXPECTED_LEDGER_ROWS) {
    throw new RehearsalRefusedError(`fixture ledger rows ${fixtureLedgerNames.length} != expected ${EXPECTED_LEDGER_ROWS}`)
  }
  if (e2.length !== EXPECTED_E2_COUNT) {
    throw new RehearsalRefusedError(`derived E2 candidates ${e2.length} != expected ${EXPECTED_E2_COUNT}: ${e2.join(', ')}`)
  }
  return { e2, ledger: [...fixtureLedgerNames].sort() }
}

// The 22 snapshot-embodied ledger rows are every repository migration older
// than the disposition window; the 4 November foundations execute for real.
function fixtureLedgerNames(files) {
  const embodied = files.filter((f) => f < '20260601000000')
  for (const n of NOVEMBER_FOUNDATION_MIGRATIONS) {
    if (!files.includes(n)) throw new RehearsalRefusedError(`November foundation missing from repository: ${n}`)
  }
  return [...embodied, ...NOVEMBER_FOUNDATION_MIGRATIONS]
}

function stagingConnection({ database }) {
  return {
    username: process.env.STAGING_DB_USER || 'postgres',
    password: process.env.STAGING_DB_PASSWORD,
    database,
    host: process.env.STAGING_DB_HOST || '127.0.0.1',
    port: process.env.STAGING_DB_PORT || 5432
  }
}

function newSequelize(cfg) {
  const { Sequelize } = require('sequelize')
  return new Sequelize(cfg.database, cfg.username, cfg.password, {
    host: cfg.host,
    port: cfg.port,
    dialect: 'postgres',
    logging: false
  })
}

async function queryAll(sequelize, sql, options = {}) {
  return sequelize.query(sql, {
    type: (sequelize.QueryTypes || require('sequelize').QueryTypes).SELECT,
    ...options
  })
}

async function createDatabase(adminCfg, name) {
  const admin = newSequelize({ ...adminCfg, database: MAINTENANCE_DB })
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.close().catch(() => {})
  }
}

async function dropDatabase(adminCfg, name) {
  const admin = newSequelize({ ...adminCfg, database: MAINTENANCE_DB })
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`)
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
  } finally {
    await admin.close().catch(() => {})
  }
}

function loadSnapshot(adminCfg, dbName) {
  const psql = spawnSync('psql', ['-h', String(adminCfg.host), '-p', String(adminCfg.port), '-U', String(adminCfg.username), '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SNAPSHOT_PATH], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: adminCfg.password || '' }
  })
  if (psql.status !== 0) {
    throw new Error(`snapshot load failed (psql exit ${psql.status}): ${(psql.stderr || psql.stdout || '').slice(0, 2000)}`)
  }
}

async function tableExists(sequelize, table) {
  const rows = await queryAll(sequelize, `SELECT to_regclass('public."${table}"') IS NOT NULL AS exists`)
  return rows[0].exists
}

async function indexExists(sequelize, name) {
  const rows = await queryAll(sequelize, `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${name}'`)
  return rows.length > 0
}

async function columnType(sequelize, table, column) {
  const rows = await queryAll(
    sequelize,
    `SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}'`
  )
  return rows.length > 0 ? rows[0].data_type : null
}

// S1a: execute the November foundation migrations' REAL up() functions.
// SCHEMA ONLY and additive; the snapshot lacks every object they create.
async function runNovemberFoundations(sequelize) {
  const { Sequelize } = require('sequelize')
  const qi = sequelize.getQueryInterface()
  const applied = []
  for (const name of NOVEMBER_FOUNDATION_MIGRATIONS) {
    const mod = require(path.join(MIGRATIONS_DIR, name))
    await mod.up(qi, Sequelize)
    applied.push(name)
  }
  return applied
}

// S1b: revert snapshot-converged numeric columns to INTEGER (guarded) so the
// E2 decimal migrations have genuine drift to converge. Empty tables: safe.
async function driftDownNumericColumns(sequelize) {
  const reverted = []
  for (const { table, column } of DRIFT_INTEGER_TARGETS) {
    if (!(await tableExists(sequelize, table))) continue
    const type = await columnType(sequelize, table, column)
    if (!type) continue
    if (!/numeric|decimal/i.test(type)) continue
    await sequelize.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE INTEGER USING "${column}"::integer`)
    reverted.push(`${table}.${column}`)
  }
  return reverted
}

// D-05 product-grade member identity indexes, owned by the E2 migration
// 20261012000001-d05-member-identity-uniqueness.js.
const D05_MEMBER_INDEXES = [
  'uq_member_store_name_ci',
  'uq_member_global_name_ci',
  'uq_member_phone_e164',
  'uq_member_email_ci'
]

// S1d: production carries member_pkey only (W-02R.3R E6). The snapshot
// already embodies the D-05 target indexes, which would turn the D-05 E2
// migration into an IF NOT EXISTS no-op; drop them so the real runner must
// genuinely create them. Staging rehearsal database only.
async function driftDownD05MemberIndexes(sequelize) {
  const dropped = []
  for (const idx of D05_MEMBER_INDEXES) {
    if (await indexExists(sequelize, idx)) {
      await sequelize.query(`DROP INDEX "${idx}"`)
      dropped.push(idx)
    }
  }
  for (const idx of D05_MEMBER_INDEXES) {
    if (await indexExists(sequelize, idx)) throw new Error(`fixture failed: D-05 index ${idx} still present before E2`)
  }
  return dropped
}

async function verifyD05MemberIndexes(sequelize) {
  const present = []
  const missing = []
  for (const idx of D05_MEMBER_INDEXES) {
    if (await indexExists(sequelize, idx)) present.push(idx)
    else missing.push(idx)
  }
  return { present, missing }
}

// S1c: minimal synthetic data — just enough for the E2 data migrations to
// exercise their real paths. No business data is fabricated.
//
// Production precondition reproduced here: the four default roles already
// exist (with pre-E2 menu literals), so the default-roles seed converges
// through its own existence guard. This matters because that seed's insert
// literal carries createdBy 'system' while role.createdBy is integer —
// executing the insert against an empty role table would fail. Production
// is safe only because its roles pre-exist; the rehearsal proves the guard
// path and records the empty-table hazard as evidence. Menus below are
// minimal representative literals (deliberately lacking the three E2 menu
// additions) — sufficient to prove append-only convergence.
async function seedSyntheticData(sequelize) {
  const seeded = []
  // One split_bill row with a concrete status so the controlled precondition
  // scan runs over data (zero NULL rows is the required precondition). The
  // split_bill -> "order" foreign key needs a parent order row first.
  const [orderRow] = await sequelize.query(
    `INSERT INTO "order" ("orderNumber", "createdAt", "updatedAt") VALUES ('W02R4-1', NOW(), NOW()) RETURNING id`,
    { type: sequelize.QueryTypes.INSERT }
  )
  const orderId = orderRow && orderRow[0] ? orderRow[0].id : null
  if (!orderId) throw new Error('fixture failed: synthetic order row not created')
  await sequelize.query(
    `INSERT INTO "split_bill" ("order", "splitNumber", "amount", "status", "createdAt", "updatedAt") VALUES ($1, 'W02R4-1', 10000, 'pending', NOW(), NOW())`,
    { bind: [orderId] }
  )
  seeded.push('split_bill:1 row (status=pending)')
  const menu = (name) => JSON.stringify([{ menu: name, read: true }])
  const roles = [
    ['Super Admin', 'super_admin', menu('dashboard')],
    ['Admin', 'admin', menu('dashboard')],
    ['Kasir', 'kasir', menu('pos')],
    ['Staff/Karyawan', 'user', menu('dashboard')]
  ]
  for (const [name, roleType, accessMenu] of roles) {
    await sequelize.query(
      `INSERT INTO "role" ("name", "roleType", "store", "accessMenu", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, NULL, $3::jsonb, 'active', NOW(), NOW())`,
      { bind: [name, roleType, accessMenu] }
    )
  }
  seeded.push('role:4 rows (pre-E2 menu literals)')
  // One user carrying the legacy 'shift' menu so the my-shift E2 exercises
  // both its role-level and user-level append paths.
  const userCols = await queryAll(
    sequelize,
    `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='user'`
  )
  const byName = Object.fromEntries(userCols.map((c) => [c.column_name, c]))
  const required = ['userName', 'email', 'password', 'roleType', 'status']
  if (required.every((c) => byName[c])) {
    await sequelize.query(
      `INSERT INTO "user" ("userName", "email", "password", "roleType", "status", "accessMenu", "createdAt", "updatedAt")
       VALUES ('w02r4_probe', 'w02r4_probe@example.test', 'not-a-real-password-hash', 'user', 'active', '[{"menu":"shift","read":true}]', NOW(), NOW())`
    )
    seeded.push('user:1 synthetic row (shift menu)')
  } else {
    seeded.push('user: skipped (required columns absent)')
  }
  return seeded
}

async function insertLedgerNames(sequelize, names) {
  if (names.length === 0) return
  const values = names.map((_, i) => `($${i + 1})`).join(', ')
  await sequelize.query(`INSERT INTO "SequelizeMeta" (name) VALUES ${values}`, { bind: [...names].sort() })
}

// S3a: region controlled indexes — missing effects only, never whole file.
async function applyRegionIndexes(sequelize) {
  if (!(await tableExists(sequelize, 'region'))) {
    throw new RehearsalRefusedError('region table absent; refusing to create it as a controlled apply')
  }
  const started = Date.now()
  const applied = []
  for (const idx of REGION_INDEXES) {
    if (await indexExists(sequelize, idx.name)) continue
    const unique = idx.unique ? 'UNIQUE ' : ''
    const cols = idx.columns.map((c) => `"${c}"`).join(', ')
    await sequelize.query(`CREATE ${unique}INDEX "${idx.name}" ON "region" (${cols})`)
    applied.push(idx.name)
  }
  for (const idx of REGION_INDEXES) {
    if (!(await indexExists(sequelize, idx.name))) throw new Error(`verification failed: index missing after apply: ${idx.name}`)
  }
  return { applied, durationMs: Date.now() - started }
}

// S3b: product_review controlled indexes — same discipline.
async function applyProductReviewIndexes(sequelize) {
  if (!(await tableExists(sequelize, 'product_review'))) {
    throw new RehearsalRefusedError('product_review table absent; refusing to create it as a controlled apply')
  }
  const started = Date.now()
  const applied = []
  for (const idx of PRODUCT_REVIEW_INDEXES) {
    if (await indexExists(sequelize, idx.name)) continue
    const cols = idx.columns.map((c) => `"${c}"`).join(', ')
    await sequelize.query(`CREATE INDEX "${idx.name}" ON "product_review" (${cols})`)
    applied.push(idx.name)
  }
  for (const idx of PRODUCT_REVIEW_INDEXES) {
    if (!(await indexExists(sequelize, idx.name))) throw new Error(`verification failed: index missing after apply: ${idx.name}`)
  }
  return { applied, durationMs: Date.now() - started }
}

// S3c: split_bill NOT NULL — precondition scan first, single-statement apply.
// Any NULL status row refuses the operation; data is never repaired here.
async function applySplitBillNotNull(sequelize) {
  const started = Date.now()
  const nullRows = await queryAll(sequelize, 'SELECT id FROM "split_bill" WHERE "status" IS NULL')
  if (nullRows.length > 0) {
    throw new RehearsalRefusedError(`split_bill has ${nullRows.length} NULL status row(s); refusing controlled apply (data repair is out of scope)`)
  }
  await sequelize.query('ALTER TABLE "split_bill" ALTER COLUMN "status" SET NOT NULL')
  const nullable = await queryAll(
    sequelize,
    `SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='split_bill' AND column_name='status'`
  )
  if (!nullable.length || nullable[0].is_nullable !== 'NO') throw new Error('verification failed: split_bill.status is still nullable')
  const keyType = await columnType(sequelize, 'split_bill', 'idempotencyKey')
  if (!keyType) throw new Error('verification failed: split_bill.idempotencyKey missing after apply')
  if (!(await indexExists(sequelize, 'split_bill_order_idempotencykey'))) {
    throw new Error('verification failed: split_bill_order_idempotencykey missing after apply')
  }
  return { applied: ['split_bill.status SET NOT NULL'], durationMs: Date.now() - started }
}

function withAppliedManifest(manifest, applyRef) {
  return {
    ...manifest,
    migrations: manifest.migrations.map((r) =>
      r.disposition === 'CONTROLLED_APPLY_PENDING' ? { ...r, disposition: 'CONTROLLED_APPLIED', applyRef } : r
    )
  }
}

// S5/S6 catalog evidence. Returns plain JSON-safe data.
async function collectCatalogEvidence(sequelize) {
  const tables = await queryAll(sequelize, `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)
  const columns = await queryAll(
    sequelize,
    `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, column_name`
  )
  const indexes = await queryAll(sequelize, `SELECT indexname, tablename FROM pg_indexes WHERE schemaname='public' ORDER BY indexname`)
  const meta = await queryAll(sequelize, 'SELECT name FROM "SequelizeMeta" ORDER BY name').catch(() => [])
  const version = await queryAll(sequelize, 'SHOW server_version').catch(() => [{ server_version: 'unknown' }])
  const hash = crypto.createHash('sha256').update(JSON.stringify({ tables, columns, indexes })).digest('hex')
  return {
    postgresVersion: (version[0] || {}).server_version || 'unknown',
    tableCount: tables.length,
    metaNames: meta.map((r) => r.name),
    schemaHash: hash,
    columns,
    indexes: indexes.map((r) => r.indexname)
  }
}

function schemaMapFromCatalog(catalog) {
  const schema = {}
  for (const c of catalog.columns) {
    if (!schema[c.table_name]) schema[c.table_name] = new Set()
    schema[c.table_name].add(c.column_name)
  }
  return schema
}

function operatorIdentity() {
  try {
    return (os.userInfo() || {}).username || 'unknown'
  } catch {
    return 'unknown'
  }
}

async function main(argv = process.argv.slice(2)) {
  const startedAt = new Date().toISOString()
  let sequelize = null
  let createdDb = null
  let keepDb = false
  let opts = null
  const timings = {}
  const evidence = {
    rehearsal: 'w02r4-staging',
    startedAt,
    operator: operatorIdentity(),
    commit: null,
    target: 'staging',
    manifestSha256: null,
    postgresVersion: null,
    stagingDb: null,
    steps: {},
    result: null
  }
  const time = async (key, fn) => {
    const t0 = Date.now()
    const out = await fn()
    timings[key] = Date.now() - t0
    return out
  }
  try {
    opts = parseArgs(argv)
    // Bind the staging connection namespace BEFORE anything else so every
    // downstream consumer (config.js staging, stamper builder, CLI spawn)
    // agrees on the rehearsal database.
    process.env.STAGING_DB_DATABASE = opts.stagingDb
    const adminCfg = stagingConnection({ database: opts.stagingDb })

    // ---- File-level validation first: no DB is touched on refusal. ----
    const { manifest, errors } = rules.readDispositionManifest(opts.manifestPath)
    if (errors.length > 0) throw new RehearsalRefusedError(errors.join('; '))
    const files = discoverMigrationFiles()
    const validation = rules.validateDispositionManifest(manifest, { files, environment: 'staging' })
    if (!validation.ok) throw new RehearsalRefusedError(`staging manifest invalid — ${validation.errors.join('; ')}`)
    if (manifest.environment !== 'staging') {
      throw new RehearsalRefusedError(`manifest environment "${manifest.environment}" is not staging (crossover refused)`)
    }
    const ledger = fixtureLedgerNames(files)
    const { e2 } = deriveRehearsalSets({ files, manifestNames: validation.names, fixtureLedgerNames: ledger })
    evidence.commit = optsManifestCommit()
    evidence.manifestSha256 = rules.sha256OfFile(opts.manifestPath)
    evidence.stagingDb = opts.stagingDb
    evidence.steps.plan = {
      repoMigrations: files.length,
      manifestRows: validation.names.length,
      fixtureLedgerRows: ledger.length,
      e2Candidates: e2,
      controlledPending: validation.rows.filter((r) => r.disposition === 'CONTROLLED_APPLY_PENDING').map((r) => r.migration),
      blocked: validation.rows.filter((r) => r.disposition === 'BLOCKED_DECISION').map((r) => r.migration)
    }
    if (!opts.apply) {
      console.log('[rehearse-staging] DRY-RUN: manifest valid, accounting reconciles, no database touched.')
      console.log(`[rehearse-staging] plan: manifest=${validation.names.length} ledger=${ledger.length} e2=${e2.length}`)
      for (const n of e2) console.log(`  runner candidate: ${n}`)
      evidence.result = 'dry-run-ok'
      return 0
    }
    if (evidence.manifestSha256 !== opts.authorizeSha256) {
      throw new RehearsalRefusedError(`manifest sha256 ${evidence.manifestSha256} does not match the authorized sha256`)
    }
    if (!validation.approved) {
      throw new RehearsalRefusedError('staging manifest is not approved (approvedBy/approvedAt pending); rehearsal refused')
    }
    // Identity guard before any mutation (create included).
    assertRehearsalTarget({ database: opts.stagingDb, host: adminCfg.host, prodDatabase: process.env.POSTGRES_DATABASE })

    // ---- Create + identity guard on the connected database. ----
    await time('createDb', () => createDatabase(adminCfg, opts.stagingDb))
    createdDb = opts.stagingDb
    sequelize = newSequelize(adminCfg)
    const connected = await queryAll(sequelize, 'SELECT current_database() AS db')
    if (connected[0].db !== opts.stagingDb) {
      throw new RehearsalRefusedError(`connected database "${connected[0].db}" is not the rehearsal database`)
    }

    // ---- S0 baseline. ----
    evidence.steps.baseline = await time('baseline', async () => {
      const catalog = await collectCatalogEvidence(sequelize)
      evidence.postgresVersion = catalog.postgresVersion
      return { postgresVersion: catalog.postgresVersion, metaNames: catalog.metaNames, schemaHash: catalog.schemaHash }
    })

    // ---- S1 snapshot + drift fixture (staging writes only). ----
    await time('snapshot', () => loadSnapshot(adminCfg, opts.stagingDb))
    evidence.steps.fixture = await time('fixture', async () => {
      const november = await runNovemberFoundations(sequelize)
      const reverted = await driftDownNumericColumns(sequelize)
      const d05Dropped = await driftDownD05MemberIndexes(sequelize)
      const seeded = await seedSyntheticData(sequelize)
      await insertLedgerNames(sequelize, ledger)
      const meta = await queryAll(sequelize, 'SELECT name FROM "SequelizeMeta" ORDER BY name')
      return { novemberFoundations: november, driftDownIntegers: reverted, driftDownD05Indexes: d05Dropped, syntheticData: seeded, ledgerInserted: meta.length }
    })

    // ---- S2 disposition stamping (INSERT-only core, same as production). ----
    evidence.steps.stamp = await time('stamp', () =>
      stamper.stampDispositions({ sequelize, manifest, files, environment: 'staging', apply: true, log: () => {} })
    )

    // ---- S3 controlled applies (missing effects only). ----
    const applyRef = `staging-rehearsal ${opts.stagingDb} ${startedAt}`
    evidence.steps.controlled = await time('controlled', async () => ({
      region: await applyRegionIndexes(sequelize),
      productReview: await applyProductReviewIndexes(sequelize),
      splitBill: await applySplitBillNotNull(sequelize),
      applyRef
    }))
    const rehearsedManifest = withAppliedManifest(manifest, applyRef)
    const revalidation = rules.validateDispositionManifest(rehearsedManifest, { files, environment: 'staging' })
    if (!revalidation.ok) throw new Error(`rehearsed manifest invalid — ${revalidation.errors.join('; ')}`)

    // ---- S4 E2 through the real runner, one timed invocation each. ----
    // Sequential --to invocations keep runner semantics identical (same
    // binary, same order, same pending calculation) while yielding honest
    // per-migration timings for the type-rewriting evidence. Gating is the
    // in-process staging preflight on the post-controlled manifest evaluated
    // fresh before every step; the file manifest is never mutated mid-run.
    const e2Results = []
    const e2PhaseStart = Date.now()
    const cli = require.resolve('sequelize-cli/lib/sequelize')
    for (const name of e2) {
      // Rehearsal E2 gate: identical to the production gate except blocked
      // decisions are ISOLATED (reported, asserted, never executed) instead
      // of refusing — D-06/D-08 remain unresolved by design (D-05 resolved
      // via EXCLUDED_BY_DECISION + the product-grade D-05 migration, which
      // runs here as E2). Approval, stamping, controlled-pending, orphan,
      // and readability checks are unchanged and still fail closed.
      const gate = preflight.evaluatePreflight({
        env: 'staging',
        targetHost: adminCfg.host,
        dispositions: rehearsedManifest,
        files,
        metaNames: (await queryAll(sequelize, 'SELECT name FROM "SequelizeMeta" ORDER BY name')).map((r) => r.name),
        isolateBlockedDecisions: true
      })
      if (!gate.ok) throw new RehearsalRefusedError(`staging preflight refused before E2 ${name}: ${gate.reasons.join('; ')}`)
      if (gate.blocked.length !== 3) {
        throw new RehearsalRefusedError(`expected 3 isolated blocked decisions before E2 ${name}, got ${gate.blocked.length}`)
      }
      const t0 = Date.now()
      const child = spawnSync(process.execPath, [cli, 'db:migrate', '--env', 'staging', '--to', name], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'staging' }
      })
      const durationMs = Date.now() - t0
      if (child.status !== 0) {
        throw new Error(`E2 runner failed at ${name} (exit ${child.status}): ${(child.stderr || child.stdout || '').slice(0, 2000)}`)
      }
      e2Results.push({ migration: name, durationMs, status: child.status })
    }
    evidence.steps.e2 = await collectE2Evidence(sequelize, e2, e2Results)
    evidence.steps.e2.phaseDurationMs = Date.now() - e2PhaseStart
    // D-05: the E2 migration must have genuinely created all four indexes.
    evidence.steps.d05Indexes = await verifyD05MemberIndexes(sequelize)
    if (evidence.steps.d05Indexes.missing.length > 0) {
      throw new Error(`D-05 E2 did not create: ${evidence.steps.d05Indexes.missing.join(', ')}`)
    }

    // ---- S5/S6 final verification. ----
    evidence.steps.verify = await time('verify', async () => {
      const catalog = await collectCatalogEvidence(sequelize)
      const schema = schemaMapFromCatalog(catalog)
      const baselineManifest = verifier.readMigrationManifest()
      const result = verifier.verifyFromState({
        files,
        manifest: baselineManifest,
        metaNames: catalog.metaNames,
        schema,
        dispositions: rehearsedManifest,
        environment: 'staging'
      })
      const data = await collectDataInvariants(sequelize)
      return {
        status: result.status,
        exitCode: result.exitCode,
        failures: result.failures,
        blocked: result.blocked,
        summary: result.summary,
        schemaHash: catalog.schemaHash,
        metaCount: catalog.metaNames.length,
        data
      }
    })
    if (evidence.steps.verify.failures.length > 0) {
      throw new Error(`final verification FAILED: ${evidence.steps.verify.failures.join('; ')}`)
    }

    evidence.timingsMs = timings
    evidence.result = evidence.steps.verify.status === 'BLOCKED' && evidence.steps.verify.blocked.length === 3 ? 'rehearsal-pass-blocked' : 'rehearsal-unexpected-state'
    if (evidence.result !== 'rehearsal-pass-blocked') {
      throw new Error(`unexpected terminal state: ${evidence.steps.verify.status} (blocked=${evidence.steps.verify.blocked.length})`)
    }
    return 0
  } catch (err) {
    evidence.result = err instanceof RehearsalRefusedError ? 'refused' : 'failed'
    evidence.error = String((err && err.message) || err).slice(0, 2000)
    keepDb = !!(opts && opts.keepOnFailure && evidence.result === 'failed')
    console.error(err instanceof RehearsalRefusedError ? err.message : `[rehearse-staging] ERROR: ${evidence.error}`)
    return 1
  } finally {
    evidence.finishedAt = new Date().toISOString()
    // Dry-run is stdout-only: it must not leave evidence files behind.
    if (evidence.result !== 'dry-run-ok') {
      try {
        writeEvidence(argv, evidence)
      } catch (e) {
        console.error(`[rehearse-staging] evidence write failed: ${String((e && e.message) || e).slice(0, 500)}`)
      }
    }
    if (sequelize) {
      try {
        await sequelize.close()
      } catch {}
    }
    if (createdDb && !keepDb) {
      try {
        const adminCfg = stagingConnection({ database: createdDb })
        await dropDatabase(adminCfg, createdDb)
        console.log(`[rehearse-staging] cleanup: dropped rehearsal database "${createdDb}"`)
      } catch (e) {
        console.error(`[rehearse-staging] cleanup FAILED for database "${createdDb}": ${String((e && e.message) || e).slice(0, 500)}`)
      }
    } else if (createdDb && keepDb) {
      console.log(`[rehearse-staging] kept rehearsal database "${createdDb}" for debugging (--keep-on-failure)`)
    }
  }
}

async function collectE2Evidence(sequelize, e2, e2Results) {
  const meta = await queryAll(sequelize, 'SELECT name FROM "SequelizeMeta" ORDER BY name')
  const metaSet = new Set(meta.map((r) => r.name))
  const missing = e2.filter((n) => !metaSet.has(n))
  if (missing.length > 0) throw new Error(`E2 migrations not recorded after runner: ${missing.join(', ')}`)
  // Non-execution proofs: effects that dispositioned migrations would have
  // destroyed or altered must still hold after the rehearsal.
  const proofs = {}
  proofs.showLogoPresent = await columnType(sequelize, 'invoice_setting', 'showLogo').then((t) => t !== null)
  const expenseDefault = await queryAll(
    sequelize,
    `SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='expense_category' AND column_name='status'`
  )
  proofs.expenseCategoryDefaultIntact = expenseDefault.length > 0 && /active/.test(expenseDefault[0].column_default || '')
  const menus = await queryAll(sequelize, `SELECT "roleType", "accessMenu" FROM "role" ORDER BY "roleType"`)
  proofs.roleMenus = menus.map((m) => ({
    roleType: m.roleType,
    menus: Array.isArray(m.accessMenu) ? m.accessMenu.map((x) => (x && x.menu) || null) : null
  }))
  // Append scope per migration source: goods-request and business-trip target
  // super_admin/admin only; my-shift targets every role with a menu plus
  // users carrying the legacy 'shift' menu. The seeded Kasir/Staff roles
  // must therefore carry my-shift but NOT goods-request/business-trip.
  const has = (menusArr, name) => Array.isArray(menusArr) && menusArr.includes(name)
  const byType = Object.fromEntries(proofs.roleMenus.map((r) => [r.roleType, r.menus]))
  proofs.e2MenuAppendsPresent =
    ['super_admin', 'admin'].every((t) => has(byType[t], 'goods-request') && has(byType[t], 'my-shift') && has(byType[t], 'business-trip')) &&
    Object.values(byType).every((mm) => has(mm, 'my-shift'))
  const users = await queryAll(sequelize, `SELECT "userName", "accessMenu" FROM "user" ORDER BY "userName"`)
  proofs.userMenus = users.map((u) => ({
    userName: u.userName,
    menus: Array.isArray(u.accessMenu) ? u.accessMenu.map((x) => (x && x.menu) || null) : null
  }))
  const probe = proofs.userMenus.find((u) => u.userName === 'w02r4_probe')
  proofs.probeUserMyShift = !!(probe && has(probe.menus, 'my-shift') && has(probe.menus, 'shift'))
  if (!proofs.e2MenuAppendsPresent) throw new Error('verification failed: E2 menu appends not converged on roles')
  if (!proofs.probeUserMyShift) throw new Error('verification failed: my-shift append not converged on synthetic user')
  const counts = {};
  for (const r of proofs.roleMenus) {
    counts[r.roleType] = (r.menus || []).filter((mm) => ['goods-request', 'my-shift', 'business-trip'].includes(mm)).length
  }
  proofs.e2MenuAppendCounts = counts
  return { executed: e2Results, missingAfterRun: missing, nonExecutionProofs: proofs }
}

async function collectDataInvariants(sequelize) {
  const out = {}
  const nullStatus = await queryAll(sequelize, 'SELECT COUNT(*) AS n FROM "split_bill" WHERE "status" IS NULL')
  out.splitBillNullStatus = Number(nullStatus[0].n)
  const roles = await queryAll(sequelize, 'SELECT "roleType", COUNT(*) AS n FROM "role" GROUP BY "roleType" ORDER BY "roleType"')
  out.rolesByType = roles.map((r) => `${r.roleType}:${r.n}`)
  const dupes = await queryAll(sequelize, 'SELECT name, COUNT(*) AS n FROM "SequelizeMeta" GROUP BY name HAVING COUNT(*) > 1')
  out.metaDuplicates = dupes.length
  const metaForOrphans = await queryAll(sequelize, 'SELECT name FROM "SequelizeMeta" ORDER BY name')
  const fileSet = new Set(discoverMigrationFiles())
  out.metaOrphans = metaForOrphans.map((r) => r.name).filter((n) => !fileSet.has(n))
  // Type convergence spot checks for the E2 decimal/bigint group.
  out.typeChecks = {}
  for (const [table, column, want] of [
    ['purchase_order', 'totalAmount', 'bigint'],
    ['goods_receipt_item', 'qtyReceived', 'numeric'],
    ['product', 'stock', 'numeric'],
    ['stock_opname_item', 'selisihJumlah', 'numeric'],
    ['stock_transfer_item', 'qty', 'numeric']
  ]) {
    out.typeChecks[`${table}.${column}`] = { want, got: await columnType(sequelize, table, column) }
  }
  return out
}

function optsManifestCommit() {
  try {
    const { spawnSync: sp } = require('child_process')
    const r = sp('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
    return (r.stdout || '').trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

function writeEvidence(argv, evidence) {
  let dir = DEFAULT_EVIDENCE_DIR
  for (const arg of argv) {
    if (arg.startsWith('--evidence-dir=')) dir = arg.slice('--evidence-dir='.length)
  }
  fs.mkdirSync(dir, { recursive: true })
  const stamp = (evidence.startedAt || new Date().toISOString()).replace(/[:.]/g, '-')
  const file = path.join(dir, `w02r4-rehearsal-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  console.log(`[rehearse-staging] evidence: ${file} (result=${evidence.result})`)
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code
  })
}

module.exports = {
  RehearsalRefusedError,
  REHEARSAL_DB_PATTERN,
  EXPECTED_REPO_MIGRATIONS,
  EXPECTED_MANIFEST_ROWS,
  EXPECTED_LEDGER_ROWS,
  EXPECTED_E2_COUNT,
  NOVEMBER_FOUNDATION_MIGRATIONS,
  DRIFT_INTEGER_TARGETS,
  D05_MEMBER_INDEXES,
  parseArgs,
  assertRehearsalTarget,
  deriveRehearsalSets,
  fixtureLedgerNames,
  stagingConnection,
  newSequelize,
  createDatabase,
  dropDatabase,
  applyRegionIndexes,
  applyProductReviewIndexes,
  applySplitBillNotNull,
  withAppliedManifest,
  main
}
