'use strict'

/**
 * Local database bootstrap (`npm run db:bootstrap`).
 *
 * The migration chain is snapshot-first (db/migration-baseline.txt): core
 * tables such as "user", "product", "order", "location" and "category" have
 * no createTable migration, so `npm run migrate` on an EMPTY database fails
 * at the second file ("No description found for "location" table"). This
 * script builds a fresh database the same way scripts/validate-migration-chain.js
 * does, but keeps it:
 *
 *   1. create the target database if it does not exist
 *   2. empty database → load scripts/dev-schema.sql and stamp every name in
 *      db/migration-baseline.txt into SequelizeMeta
 *      baseline-shaped database (core tables present) → skip to step 3
 *      anything else → refuse
 *   3. run the pending tail through the guarded runner
 *      (scripts/run-migrations.js → preflight → sequelize-cli db:migrate)
 *
 * Schema only. Data the baseline migrations used to insert (default roles,
 * admin users, payment methods) is not created; run `npx sequelize-cli
 * db:seed:all` (and `npm run seed:regions`) afterwards if you need it.
 *
 * Safety: local hosts only; production and staging are refused before
 * connecting. Usage:
 *   npm run db:bootstrap                 # development (DB_DEV_DATABASE, default cashier_app)
 *   npm run db:bootstrap -- --env test   # test (DB_TEST_DATABASE)
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { Client } = require('pg')

const ROOT = path.join(__dirname, '..')
const SNAPSHOT_PATH = path.join(ROOT, 'scripts', 'dev-schema.sql')
const MANIFEST_PATH = path.join(ROOT, 'db', 'migration-baseline.txt')
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations')
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const ALLOWED_ENVS = new Set(['development', 'test'])
const CORE_TABLES = ['user', 'location', 'product', 'order', 'category']

const log = (msg) => console.log(`[db:bootstrap] ${msg}`)

function parseEnv(argv) {
  const i = argv.indexOf('--env')
  if (i !== -1) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith('--env='))
  return eq ? eq.slice('--env='.length) : process.env.NODE_ENV || 'development'
}

function readManifest() {
  return fs
    .readFileSync(MANIFEST_PATH, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

// Pure decision on the target's public tables (SequelizeMeta excluded).
function classifyTables(tables) {
  if (tables.length === 0) return 'empty'
  if (CORE_TABLES.every((t) => tables.includes(t))) return 'baseline'
  return 'unknown'
}

function run(cmd, args, cfg, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, PGPASSWORD: cfg.password || '' },
    ...opts
  })
  if (res.status !== 0) throw new Error(`${cmd} ${args[0]} exited ${res.status}`)
}

async function withClient(cfg, database, fn) {
  const client = new Client({
    host: cfg.host,
    port: Number(cfg.port),
    user: cfg.username,
    password: cfg.password || undefined,
    database
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function main() {
  const env = parseEnv(process.argv.slice(2))
  if (!ALLOWED_ENVS.has(env)) {
    throw new Error(`refusing: environment "${env}" (only ${[...ALLOWED_ENVS].join(', ')}; never production/staging)`)
  }
  process.env.NODE_ENV = env
  const cfg = require('../config/config.js')[env]
  if (!LOCAL_HOSTS.has(String(cfg.host || '').toLowerCase())) {
    throw new Error(`refusing: host "${cfg.host}" is not local`)
  }
  const db = cfg.database
  log(`target env=${env} host=${cfg.host} db=${db}`)

  const exists = await withClient(cfg, 'postgres', async (c) => {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])
    return r.rowCount > 0
  })
  if (!exists) {
    run('createdb', ['-h', cfg.host, '-p', String(cfg.port), '-U', cfg.username, db], cfg)
    log('database created')
  }

  const tables = await withClient(cfg, db, async (c) => {
    const r = await c.query(
      `SELECT tablename FROM pg_catalog.pg_tables
       WHERE schemaname = 'public' AND tablename <> 'SequelizeMeta'`
    )
    return r.rows.map((row) => row.tablename)
  })
  const state = classifyTables(tables)

  if (state === 'unknown') {
    throw new Error(
      `refusing: "${db}" is neither empty nor baseline-shaped ` +
        `(missing core tables: ${CORE_TABLES.filter((t) => !tables.includes(t)).join(', ')})`
    )
  }

  if (state === 'empty') {
    const files = new Set(fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js')))
    const manifest = readManifest()
    const unknown = manifest.filter((n) => !files.has(n))
    if (unknown.length > 0) throw new Error(`baseline entry has no migration file: ${unknown.join(', ')}`)

    run(
      'psql',
      ['-h', cfg.host, '-p', String(cfg.port), '-U', cfg.username, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', '-f', SNAPSHOT_PATH],
      cfg
    )
    log('snapshot baseline loaded (scripts/dev-schema.sql)')

    await withClient(cfg, db, (c) =>
      c.query(
        `INSERT INTO "SequelizeMeta" (name) SELECT unnest($1::varchar[]) ON CONFLICT (name) DO NOTHING`,
        [manifest]
      )
    )
    log(`baseline history stamped (${manifest.length} migrations)`)
  } else {
    log('core tables present — skipping snapshot load')
  }

  run(process.execPath, [path.join(ROOT, 'scripts', 'run-migrations.js'), '--env', env], cfg, { cwd: ROOT })
  log('done')
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[db:bootstrap] FAIL: ${err.message}`)
    process.exit(1)
  })
}

module.exports = { classifyTables, parseEnv, CORE_TABLES }
