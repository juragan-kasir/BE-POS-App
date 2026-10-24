process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W-02R.4 — staging rehearsal contract tests.
//
// Pure isolation tests run without a database. Anything touching tables uses
// either disposable probe tables on the isolated test database (pid-suffixed,
// dropped afterwards — never shared tables) or a dedicated disposable
// database that the suite creates and drops. Production and staging-shared
// infrastructure are never contacted.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const rules = require('../scripts/migration-dispositions')
const stamper = require('../scripts/apply-migration-dispositions')
const preflight = require('../scripts/check-migration-preflight')
const harness = require('../scripts/rehearse-staging')
const { discoverMigrationFiles } = require('../scripts/check-production-schema')

const FILES = discoverMigrationFiles()
const STAGING_MANIFEST = () => rules.readDispositionManifest(rules.STAGING_DISPOSITIONS_PATH).manifest
const PRODUCTION_MANIFEST = () => rules.readDispositionManifest(rules.PRODUCTION_DISPOSITIONS_PATH).manifest

const KNOWN_E2 = [
  '20260613000003-insert-default-roles.js',
  '20260810000002-add-goods-request-menu-access.js',
  '20260827000004-add-my-shift-access-menu.js',
  '20260902000002-add-business-trip-menu-access.js',
  '20261001000001-purchase-monetary-bigint.js',
  '20261001000002-goods-receipt-item-qty-decimal.js',
  '20261001000003-goods-receipt-idempotency.js',
  '20261002000001-fractional-stock-decimal.js',
  '20261004000001-stock-opname-decimal.js',
  '20261006000001-stock-transfer-idempotency-decimal.js',
  '20261007000001-add-dr20-foundation-fields-to-audit-log.js',
  '20261011000001-add-reactivated-at-to-tenant-membership.js',
  '20261012000001-d05-member-identity-uniqueness.js',
  '20261013000001-p1-transaction-attribution.js',
  '20261013000002-p1-transaction-linkage-fks.js',
  '20261013000004-p1-register-close-snapshot.js',
  // D-08 E2 Option C: M3 sorts after M5 (B1 → B2 → B3, scripts/migration-batches.js).
  '20261013000005-p1-canonical-payment-check.js',
  // P1-5 B4: goods_receipt.stockPosted posting flag (guarded add-column).
  '20261016210748-add-stock-posted-to-goods-receipt.js',
  // FG-SEC-05: auditLog append-only database backstop (FK + triggers).
  '20261023000001-harden-audit-log.js',
  // BA DR-28: widen columns to the field-length standard (catalog-only).
  '20261024000001-dr28-widen-text-columns.js'
]

// Locked intentional staging/production divergence (D-06 manifest
// correction). Production records the decisions (DR-21, DR-06) as
// EXCLUDED_BY_DECISION; staging deliberately keeps these exact three rows as
// BLOCKED_DECISION so the rehearsal keeps proving that blocked rows stop
// execution (rehearsal-pass-blocked, 3 blocked). No other row may differ.
const STAGING_DIVERGENCE = Object.freeze({
  '20260616000002-fix-tax-config-audit-fields-type.js': {
    staging: { disposition: 'BLOCKED_DECISION', decisionRef: 'D-06 tax_config audit-field type' },
    productionDecisionRef: /^DR-21\b/
  },
  '20260618000004-create-super-admin-users.js': {
    staging: { disposition: 'BLOCKED_DECISION', decisionRef: 'D-08/DR-06 production seed-account roster' },
    productionDecisionRef: /^DR-06\b/
  },
  '20260620000005-create-dev-user.js': {
    staging: { disposition: 'BLOCKED_DECISION', decisionRef: 'D-08/DR-06 production seed-account roster' },
    productionDecisionRef: /^DR-06\b/
  }
})

// The rehearsal's blocked set is exactly the allowlisted staging rows.
const EXPECTED_STAGING_BLOCKED = Object.entries(STAGING_DIVERGENCE)
  .map(([migration, { staging }]) => ({ migration, decisionRef: staging.decisionRef }))
  .sort((a, b) => a.migration.localeCompare(b.migration))
const sortBlocked = (list) =>
  list
    .map((b) => ({ migration: b.migration, decisionRef: b.decisionRef }))
    .sort((a, b) => a.migration.localeCompare(b.migration))

// Returns every violation of the divergence contract (empty = compliant):
// identical migration inventory and order, identical shared top-level fields
// (schemaVersion, evidenceCapturedAt), byte-identical rows outside the
// allowlist, and the allowlisted rows in exactly their locked
// staging/production shapes. approvedBy/approvedAt are deliberately NOT
// compared: each manifest has its own whole-file approval, and approving one
// environment never authorizes the other (db/migration-dispositions/README.md).
// A verified production controlled-apply progression is likewise not
// unexpected divergence (see isVerifiedControlledProgression below): the
// staging rehearsal manifest is independent and keeps exercising the pending
// path on disposable databases while production legitimately moves on.
const isVerifiedControlledProgression = (s, p) =>
  s.disposition === 'CONTROLLED_APPLY_PENDING' &&
  p.disposition === 'CONTROLLED_APPLIED' &&
  s.migration === p.migration &&
  s.evidenceRef === p.evidenceRef &&
  !('applyRef' in s) &&
  typeof p.applyRef === 'string' &&
  p.applyRef.startsWith('controlled-apply/') &&
  Object.keys(s).sort().join(',') === 'disposition,evidenceRef,migration' &&
  Object.keys(p).sort().join(',') === 'applyRef,disposition,evidenceRef,migration'
const stagingDivergenceViolations = (staging, production) => {
  const out = []
  const sNames = staging.migrations.map((r) => r.migration)
  const pNames = production.migrations.map((r) => r.migration)
  if (JSON.stringify(sNames) !== JSON.stringify(pNames)) out.push('migration inventory/order differs between staging and production')
  if (new Set(sNames).size !== sNames.length) out.push('staging migration inventory has duplicates')
  if (new Set(pNames).size !== pNames.length) out.push('production migration inventory has duplicates')
  for (const key of ['schemaVersion', 'evidenceCapturedAt']) {
    if (JSON.stringify(staging[key]) !== JSON.stringify(production[key])) out.push(`top-level ${key} differs`)
  }
  const pBy = new Map(production.migrations.map((r) => [r.migration, r]))
  for (const s of staging.migrations) {
    const p = pBy.get(s.migration)
    if (!p) continue
    const locked = STAGING_DIVERGENCE[s.migration]
    if (!locked) {
      if (JSON.stringify(s) !== JSON.stringify(p) && !isVerifiedControlledProgression(s, p)) {
        out.push(`unexpected divergence: ${s.migration}`)
      }
      continue
    }
    const sKeys = Object.keys(s).sort().join(',')
    if (
      s.disposition !== locked.staging.disposition ||
      s.decisionRef !== locked.staging.decisionRef ||
      sKeys !== 'decisionRef,disposition,evidenceRef,migration' ||
      typeof s.evidenceRef !== 'string' ||
      s.evidenceRef.length === 0
    ) {
      out.push(`staging row for ${s.migration} no longer matches the locked BLOCKED_DECISION contract`)
    }
    if (p.disposition !== 'EXCLUDED_BY_DECISION' || !locked.productionDecisionRef.test(p.decisionRef || '') || 'supersededBy' in p) {
      out.push(`production row for ${s.migration} no longer matches the locked EXCLUDED_BY_DECISION contract`)
    }
    if (JSON.stringify(s) === JSON.stringify(p)) out.push(`allowlisted row ${s.migration} no longer diverges`)
  }
  return out
}

describe('W-02R.4 staging manifest (locked rehearsal contract)', () => {
  test('staging manifest is valid, unapproved, 197 rows, zero D-07', () => {
    const { manifest, errors } = rules.readDispositionManifest(rules.STAGING_DISPOSITIONS_PATH)
    expect(errors).toEqual([])
    const r = rules.validateDispositionManifest(manifest, { files: FILES, environment: 'staging' })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.approved).toBe(false)
    expect(manifest.approvedBy).toBeNull()
    expect(manifest.approvedAt).toBeNull()
    expect(r.names).toHaveLength(197)
    expect(JSON.stringify(manifest)).not.toMatch(/D-07/)
  })

  test('staging rows equal production rows except the locked intentional-divergence allowlist', () => {
    const staging = STAGING_MANIFEST()
    const production = PRODUCTION_MANIFEST()
    expect(stagingDivergenceViolations(staging, production)).toEqual([])
    expect(staging.environment).toBe('staging')
    expect(production.environment).toBe('production')
  })

  test('the allowlisted rows diverge exactly as locked (staging BLOCKED, production EXCLUDED_BY_DECISION)', () => {
    const staging = Object.fromEntries(STAGING_MANIFEST().migrations.map((r) => [r.migration, r]))
    const production = Object.fromEntries(PRODUCTION_MANIFEST().migrations.map((r) => [r.migration, r]))
    for (const [name, expected] of Object.entries(STAGING_DIVERGENCE)) {
      expect(staging[name]).toStrictEqual({ migration: name, ...expected.staging, evidenceRef: staging[name].evidenceRef })
      expect(staging[name].evidenceRef).toMatch(/^W-02R\.3R matrix v2 E6 \(HIGH\): /)
      expect(production[name].disposition).toBe('EXCLUDED_BY_DECISION')
      expect(production[name].decisionRef).toMatch(expected.productionDecisionRef)
      expect(Object.keys(production[name]).sort()).toEqual(['decisionRef', 'disposition', 'evidenceRef', 'migration'])
    }
  })

  test('divergence contract fails closed on any drift beyond the allowlist', () => {
    const staging = STAGING_MANIFEST()
    const production = PRODUCTION_MANIFEST()
    const clone = (m) => JSON.parse(JSON.stringify(m))
    const at = (m, name) => m.migrations.find((r) => r.migration === name)
    const ATTESTED = '20260616000002-add-ingredient-to-goods-receipt-item.js'
    const check = (mutate) => {
      const s = clone(staging)
      const p = clone(production)
      mutate(s, p)
      return stagingDivergenceViolations(s, p)
    }

    // A fourth divergent row (any field, including evidence/decision text).
    expect(check((s) => { at(s, ATTESTED).evidenceRef += ' edited' }).join('\n')).toMatch(/unexpected divergence: 20260616000002-add-ingredient/)
    expect(check((s) => { at(s, ATTESTED).decisionRef = 'DR-99' }).join('\n')).toMatch(/unexpected divergence/)
    expect(check((s) => { delete at(s, ATTESTED).evidenceRef }).join('\n')).toMatch(/unexpected divergence/)
    // Inventory drift: removal, addition, reorder, duplicate.
    expect(check((s) => { s.migrations.pop() }).join('\n')).toMatch(/inventory/)
    expect(check((s, p) => { p.migrations.push({ migration: '29991231000000-new.js', disposition: 'ATTESTED_PRESENT', evidenceRef: 'x' }) }).join('\n')).toMatch(/inventory/)
    expect(check((s) => { s.migrations.reverse() }).join('\n')).toMatch(/inventory/)
    expect(check((s) => { s.migrations[1] = clone(s.migrations[0]) }).join('\n')).toMatch(/inventory/)
    // An allowlisted row converging or changing on either side.
    const TAX = '20260616000002-fix-tax-config-audit-fields-type.js'
    const synced = check((s, p) => { Object.assign(at(s, TAX), at(p, TAX)) }).join('\n')
    expect(synced).toMatch(/staging row for 20260616000002-fix-tax-config/)
    expect(synced).toMatch(/allowlisted row 20260616000002-fix-tax-config.* no longer diverges/)
    expect(check((s) => { at(s, '20260620000005-create-dev-user.js').decisionRef = 'DR-06' }).join('\n')).toMatch(/staging row for 20260620000005/)
    expect(check((s, p) => { at(p, '20260618000004-create-super-admin-users.js').disposition = 'BLOCKED_DECISION' }).join('\n')).toMatch(/production row for 20260618000004/)
    expect(check((s, p) => { at(p, '20260618000004-create-super-admin-users.js').decisionRef = 'D-08/DR-06 production seed-account roster' }).join('\n')).toMatch(/production row for 20260618000004/)
    // Top-level drift other than environment / approval.
    expect(check((s) => { s.evidenceCapturedAt = '2026-10-05T00:00:00Z' }).join('\n')).toMatch(/evidenceCapturedAt/)
    expect(check((s) => { s.schemaVersion = 2 }).join('\n')).toMatch(/schemaVersion/)
    // Untouched pair is clean.
    expect(check(() => {})).toEqual([])
  })

  test('approval is environment-specific: production approval alone is not a staging divergence', () => {
    const staging = STAGING_MANIFEST()
    const production = PRODUCTION_MANIFEST()
    const clone = (m) => JSON.parse(JSON.stringify(m))
    // Staging stays independently unapproved while production is approved.
    expect(staging.approvedBy).toBeNull()
    expect(staging.approvedAt).toBeNull()
    const approvedProd = { ...clone(production), approvedBy: 'approver@example.test', approvedAt: '2026-10-06T00:00:00Z' }
    const unapprovedProd = { ...clone(production), approvedBy: null, approvedAt: null }
    expect(stagingDivergenceViolations(clone(staging), approvedProd)).toEqual([])
    expect(stagingDivergenceViolations(clone(staging), unapprovedProd)).toEqual([])
    // Shared fields and row/inventory drift still fail closed.
    expect(stagingDivergenceViolations({ ...clone(staging), evidenceCapturedAt: '2026-10-06T00:00:00Z' }, approvedProd).join('\n')).toMatch(/evidenceCapturedAt/)
    expect(stagingDivergenceViolations({ ...clone(staging), schemaVersion: 2 }, approvedProd).join('\n')).toMatch(/schemaVersion/)
    const reordered = clone(staging)
    reordered.migrations.reverse()
    expect(stagingDivergenceViolations(reordered, approvedProd).join('\n')).toMatch(/inventory/)
    const drifted = clone(staging)
    drifted.migrations.find((r) => r.migration === '20260616000002-add-ingredient-to-goods-receipt-item.js').evidenceRef += ' edited'
    expect(stagingDivergenceViolations(drifted, approvedProd).join('\n')).toMatch(/unexpected divergence/)
    // Production approval never authorizes staging: the staging manifest still validates as unapproved.
    const r = rules.validateDispositionManifest(clone(staging), { files: FILES, environment: 'staging' })
    expect(r.ok).toBe(true)
    expect(r.approved).toBe(false)
  })

  test('derived E2 set equals the locked 20 and partitions 243 = 197 + 26 + 20', () => {
    const staging = STAGING_MANIFEST()
    const ledger = harness.fixtureLedgerNames(FILES)
    expect(ledger).toHaveLength(26)
    const { e2 } = harness.deriveRehearsalSets({
      files: FILES,
      manifestNames: staging.migrations.map((r) => r.migration),
      fixtureLedgerNames: ledger
    })
    expect(e2).toEqual(KNOWN_E2)
  })

  test('accounting derivation fails closed on drift', () => {
    const staging = STAGING_MANIFEST()
    const ledger = harness.fixtureLedgerNames(FILES)
    const names = staging.migrations.map((r) => r.migration)
    expect(() =>
      harness.deriveRehearsalSets({ files: [...FILES, '29991231000000-new.js'], manifestNames: names, fixtureLedgerNames: ledger })
    ).toThrow(/review the manifest/)
    expect(() =>
      harness.deriveRehearsalSets({ files: FILES, manifestNames: names.slice(1), fixtureLedgerNames: ledger })
    ).toThrow(/manifest rows/)
  })
})

describe('W-02R.4 target isolation (no database)', () => {
  test('unknown targets are refused everywhere', () => {
    expect(() => stamper.parseArgs(['--target=bogus'])).toThrow(/no disposition manifest exists/)
    expect(() => stamper.parseArgs(['--target=stagingg', '--apply', '--authorize-manifest-sha256=' + 'a'.repeat(64)])).toThrow(
      /no disposition manifest exists/
    )
    // Harness value shape is accepted by the parser; the rehearsal-name
    // pattern itself is enforced by assertRehearsalTarget in main(), before
    // any mutation (layered refusal, covered below).
    expect(harness.parseArgs(['--staging-db=bogus']).stagingDb).toBe('bogus')
    expect(() => harness.parseArgs([])).toThrow(/--staging-db/)
    expect(() => harness.parseArgs(['--staging-db=x', '--wat'])).toThrow(/unknown argument/)
  })

  test('target -> manifest mapping is explicit and disjoint', () => {
    expect(stamper.MANIFEST_BY_TARGET.production).toBe(rules.PRODUCTION_DISPOSITIONS_PATH)
    expect(stamper.MANIFEST_BY_TARGET.staging).toBe(rules.STAGING_DISPOSITIONS_PATH)
    expect(stamper.MANIFEST_BY_TARGET.production).not.toBe(stamper.MANIFEST_BY_TARGET.staging)
    expect(preflight.MANIFEST_BY_ENV.production).toBe(rules.PRODUCTION_DISPOSITIONS_PATH)
    expect(preflight.MANIFEST_BY_ENV.staging).toBe(rules.STAGING_DISPOSITIONS_PATH)
  })

  test('production manifest is refused as staging and vice versa', () => {
    const prod = PRODUCTION_MANIFEST()
    const staging = STAGING_MANIFEST()
    expect(rules.validateDispositionManifest(prod, { files: FILES, environment: 'staging' }).ok).toBe(false)
    expect(rules.validateDispositionManifest(staging, { files: FILES, environment: 'production' }).ok).toBe(false)
    expect(rules.validateDispositionManifest(prod, { files: FILES, environment: 'production' }).ok).toBe(true)
    expect(rules.validateDispositionManifest(staging, { files: FILES, environment: 'staging' }).ok).toBe(true)
  })

  test('blocked isolation mode reports but does not fail (rehearsal E2 gate)', () => {
    const staging = { ...STAGING_MANIFEST(), approvedBy: 't', approvedAt: '2026-10-03T00:00:00Z' }
    const metaNames = [...FILES]
    const strict = preflight.evaluatePreflight({ env: 'staging', targetHost: '127.0.0.1', dispositions: staging, files: FILES, metaNames })
    expect(strict.ok).toBe(false)
    expect(strict.blocked).toHaveLength(3)
    // Each blocked migration is identified with its decision reference.
    expect(sortBlocked(strict.blocked)).toEqual(EXPECTED_STAGING_BLOCKED)
    const reasons = strict.reasons.join('\n')
    expect(reasons).toMatch(/BLOCKED_DECISION remains \(3\)/)
    for (const b of EXPECTED_STAGING_BLOCKED) expect(reasons).toContain(`${b.migration} [${b.decisionRef}]`)
    const applied = {
      ...staging,
      migrations: staging.migrations.map((r) =>
        r.disposition === 'CONTROLLED_APPLY_PENDING' ? { ...r, disposition: 'CONTROLLED_APPLIED', applyRef: 'test' } : r
      )
    }
    const gate = preflight.evaluatePreflight({
      env: 'staging',
      targetHost: '127.0.0.1',
      dispositions: applied,
      files: FILES,
      metaNames,
      isolateBlockedDecisions: true
    })
    expect(gate.ok).toBe(true)
    expect(gate.blocked).toHaveLength(3)
    expect(sortBlocked(gate.blocked)).toEqual(EXPECTED_STAGING_BLOCKED)
  })

  test('preflight selects the manifest strictly by environment', () => {
    const staging = { ...STAGING_MANIFEST(), approvedBy: 't', approvedAt: '2026-10-03T00:00:00Z' }
    const metaNames = [...FILES]
    const asStaging = preflight.evaluatePreflight({ env: 'staging', targetHost: '127.0.0.1', dispositions: staging, files: FILES, metaNames })
    // Controlled-pending rows remain, so this refuses on pending — but it
    // must get PAST manifest selection (no environment-mismatch error).
    expect(asStaging.reasons.join('\n')).toMatch(/CONTROLLED_APPLY_PENDING remains/)
    expect(asStaging.reasons.join('\n')).not.toMatch(/does not match target/)
    const crossed = preflight.evaluatePreflight({
      env: 'staging',
      targetHost: '127.0.0.1',
      dispositions: PRODUCTION_MANIFEST(),
      files: FILES,
      metaNames
    })
    expect(crossed.ok).toBe(false)
    expect(crossed.reasons.join('\n')).toMatch(/does not match target/)
  })
})

describe('W-02R.4 approval + SHA isolation (no database)', () => {
  test('staging approval is all-or-nothing and independent of production', () => {
    const staging = STAGING_MANIFEST()
    const half = { ...staging, approvedBy: 'someone@example.test', approvedAt: null }
    expect(rules.validateDispositionManifest(half, { files: FILES, environment: 'staging' }).ok).toBe(false)
    const approvedStaging = { ...staging, approvedBy: 'someone@example.test', approvedAt: '2026-10-03T00:00:00Z' }
    const r = rules.validateDispositionManifest(approvedStaging, { files: FILES, environment: 'staging' })
    expect(r.ok).toBe(true)
    expect(r.approved).toBe(true)
    // Production approval (same identity, production file) cannot validate a
    // staging action: environment binding is independent of who approved.
    const prod = PRODUCTION_MANIFEST()
    expect(rules.validateDispositionManifest({ ...prod, approvedBy: 'someone@example.test', approvedAt: '2026-10-03T00:00:00Z' }, { files: FILES, environment: 'staging' }).ok).toBe(false)
  })

  test('SHA binds exact bytes: production SHA never authorizes staging', () => {
    const prodSha = rules.sha256OfFile(rules.PRODUCTION_DISPOSITIONS_PATH)
    const stagingSha = rules.sha256OfFile(rules.STAGING_DISPOSITIONS_PATH)
    expect(prodSha).toMatch(/^[0-9a-f]{64}$/)
    expect(stagingSha).toMatch(/^[0-9a-f]{64}$/)
    expect(prodSha).not.toBe(stagingSha)
    const tmp = path.join(os.tmpdir(), `w02r4-sha-${process.pid}.json`)
    fs.copyFileSync(rules.STAGING_DISPOSITIONS_PATH, tmp)
    try {
      fs.appendFileSync(tmp, '\n')
      expect(rules.sha256OfFile(tmp)).not.toBe(stagingSha)
    } finally {
      fs.unlinkSync(tmp)
    }
    expect(() => stamper.parseArgs(['--target=staging', '--apply', '--authorize-manifest-sha256=zzz'])).toThrow(
      /requires --authorize-manifest-sha256/
    )
  })
})

describe('W-02R.4 database identity guard (pure, no database)', () => {
  const good = { database: 'cashier_app_staging_rehearsal', host: '127.0.0.1', prodDatabase: 'cashier_app_prod' }
  test('accepts a rehearsal-pattern local database', () => {
    expect(harness.assertRehearsalTarget(good)).toEqual({ database: good.database, host: good.host })
    expect(harness.assertRehearsalTarget({ ...good, database: 'cashier_app_staging_rehearsal_x1', host: 'localhost' })).toBeTruthy()
  })
  test('rejects non-rehearsal names', () => {
    for (const database of ['cashier_app', 'cashier_app_test', 'staging', '', 'cashier_app_staging_rehearsal-x', 'Cashier_App_Staging_Rehearsal']) {
      expect(() => harness.assertRehearsalTarget({ ...good, database })).toThrow(/ephemeral pattern/)
    }
  })
  test('rejects production crossover and non-local hosts', () => {
    expect(() => harness.assertRehearsalTarget({ ...good, prodDatabase: good.database })).toThrow(/crossover/)
    expect(() => harness.assertRehearsalTarget({ ...good, host: 'ep-prod.example.neon.tech' })).toThrow(/not local/)
    expect(() => harness.assertRehearsalTarget({ ...good, host: '' })).toThrow(/not local/)
  })
  test('staging builder refuses missing vars and production crossover', () => {
    const saved = { ...process.env }
    try {
      delete process.env.STAGING_DB_USER
      delete process.env.STAGING_DB_DATABASE
      delete process.env.STAGING_DB_HOST
      expect(() => stamper.buildStagingSequelize()).toThrow(/is not set for target staging/)
      process.env.STAGING_DB_USER = 'u'
      process.env.STAGING_DB_DATABASE = 'same_db'
      process.env.STAGING_DB_HOST = '127.0.0.1'
      process.env.POSTGRES_DATABASE = 'same_db'
      expect(() => stamper.buildStagingSequelize()).toThrow(/crossover/)
    } finally {
      process.env = saved
    }
  })
})

describe('W-02R.4 staging stamper on disposable probe tables (test DB)', () => {
  const db = require('../db/models')
  const TABLE = `w02r4_meta_probe_${process.pid}`
  const approvedStaging = () => ({ ...STAGING_MANIFEST(), approvedBy: 'w02r4-test', approvedAt: '2026-10-03T00:00:00Z' })
  const stamp = (manifest, apply) =>
    stamper.stampDispositions({ sequelize: db.sequelize, manifest, files: FILES, environment: 'staging', apply, metaTable: TABLE })

  beforeAll(async () => {
    await db.sequelize.query(`CREATE TABLE "${TABLE}" (name VARCHAR(255) NOT NULL PRIMARY KEY)`)
  })
  afterAll(async () => {
    await db.sequelize.query(`DROP TABLE IF EXISTS "${TABLE}"`)
  })

  test('unapproved staging manifest: mutation refused', async () => {
    await expect(stamp(STAGING_MANIFEST(), true)).rejects.toThrow(/not approved/)
  })

  test('approved staging manifest stamps INSERT-only and is idempotent', async () => {
    const first = await stamp(approvedStaging(), true)
    expect(first.mode).toBe('apply')
    expect(first.inserted).toHaveLength(197)
    const second = await stamp(approvedStaging(), true)
    expect(second.inserted).toHaveLength(0)
  })

  test('pre-existing rows are never rewritten', async () => {
    const first = approvedStaging().migrations[0].migration
    await db.sequelize.query(`TRUNCATE "${TABLE}"`)
    await db.sequelize.query(`INSERT INTO "${TABLE}" (name) VALUES ($1)`, { bind: [first] })
    const result = await stamp(approvedStaging(), true)
    expect(result.alreadyRecorded).toBe(1)
    const rows = await db.sequelize.query(`SELECT name FROM "${TABLE}" ORDER BY name`, { type: db.sequelize.QueryTypes.SELECT })
    expect(rows.map((r) => r.name)).toContain(first)
    expect(rows).toHaveLength(197)
  })

  test('orphan and duplicate ledger rows are refused', async () => {
    await db.sequelize.query(`TRUNCATE "${TABLE}"`)
    await db.sequelize.query(`INSERT INTO "${TABLE}" (name) VALUES ('29991231000000-orphan.js')`)
    await expect(stamp(approvedStaging(), true)).rejects.toThrow(/no migration file/)
    await db.sequelize.query(`TRUNCATE "${TABLE}"`)
  })
})

describe('W-02R.4 controlled applies on a disposable database', () => {
  const DB = `cashier_app_staging_rehearsal_ctl_${process.pid}`
  const cfg = () => harness.stagingConnection({ database: DB })
  let sequelize = null

  beforeAll(async () => {
    process.env.STAGING_DB_DATABASE = DB
    const admin = harness.stagingConnection({ database: DB })
    await harness.createDatabase(admin, DB)
    sequelize = harness.newSequelize(cfg())
    await sequelize.query('CREATE TABLE region (id SERIAL PRIMARY KEY, code VARCHAR(20), level VARCHAR(10), "parentCode" VARCHAR(20))')
    await sequelize.query('CREATE TABLE product_review (id SERIAL PRIMARY KEY, "productId" INTEGER, store INTEGER)')
    await sequelize.query(
      'CREATE TABLE split_bill (id SERIAL PRIMARY KEY, "order" INTEGER, status VARCHAR(20), "idempotencyKey" VARCHAR(255))'
    )
    await sequelize.query('CREATE INDEX split_bill_order_idempotencykey ON split_bill ("order", "idempotencyKey")')
  }, 120000)

  afterAll(async () => {
    if (sequelize) await sequelize.close().catch(() => {})
    const admin = harness.stagingConnection({ database: DB })
    await harness.dropDatabase(admin, DB).catch(() => {})
    delete process.env.STAGING_DB_DATABASE
  })

  test('region indexes converge from absent and rerun is idempotent', async () => {
    const first = await harness.applyRegionIndexes(sequelize)
    expect(first.applied.sort()).toEqual(['region_code_unique', 'region_level_idx', 'region_parent_code_idx'].sort())
    const second = await harness.applyRegionIndexes(sequelize)
    expect(second.applied).toEqual([])
  })

  test('product_review indexes converge from absent', async () => {
    const result = await harness.applyProductReviewIndexes(sequelize)
    expect(result.applied.sort()).toEqual(['product_review_product_store', 'product_review_store'].sort())
  })

  test('split_bill refuses NULL status and converges when clean', async () => {
    await sequelize.query(`INSERT INTO split_bill ("order", status, "idempotencyKey") VALUES (1, NULL, 'k1')`)
    await expect(harness.applySplitBillNotNull(sequelize)).rejects.toThrow(/NULL status/)
    await sequelize.query(`DELETE FROM split_bill WHERE "idempotencyKey" = 'k1'`)
    const result = await harness.applySplitBillNotNull(sequelize)
    expect(result.applied).toEqual(['split_bill.status SET NOT NULL'])
    await sequelize.query('ALTER TABLE split_bill ALTER COLUMN status DROP NOT NULL')
  })

  test('controlled apply refuses a missing table instead of creating it', async () => {
    await sequelize.query('DROP TABLE region')
    await expect(harness.applyRegionIndexes(sequelize)).rejects.toThrow(/absent/)
    await sequelize.query('CREATE TABLE region (id SERIAL PRIMARY KEY, code VARCHAR(20), level VARCHAR(10), "parentCode" VARCHAR(20))')
    await harness.applyRegionIndexes(sequelize)
  })
})

describe('W-02R.4 E2 data-migration idempotency (disposable database)', () => {
  const DB = `cashier_app_staging_rehearsal_e2id_${process.pid}`
  let sequelize = null
  const qi = () => sequelize.getQueryInterface()
  const runUp = (name) => require(`../db/migrations/${name}`).up(qi(), require('sequelize'))

  beforeAll(async () => {
    const admin = harness.stagingConnection({ database: DB })
    await harness.createDatabase(admin, DB)
    sequelize = harness.newSequelize({ ...admin, database: DB })
    await sequelize.query(
      'CREATE TABLE role (id SERIAL PRIMARY KEY, name VARCHAR(255), "roleType" VARCHAR(30), store INTEGER, "accessMenu" JSONB NOT NULL, status VARCHAR(20), "createdBy" INTEGER, "createdAt" TIMESTAMPTZ NOT NULL, "updatedAt" TIMESTAMPTZ)'
    )
    await sequelize.query('CREATE TABLE "user" (id SERIAL PRIMARY KEY, "accessMenu" JSONB, "updatedAt" TIMESTAMPTZ)')
  }, 120000)

  afterAll(async () => {
    if (sequelize) await sequelize.close().catch(() => {})
    await harness.dropDatabase(harness.stagingConnection({ database: DB }), DB).catch(() => {})
  })

  test('menu appends converge exactly once across reruns', async () => {
    await sequelize.query(`INSERT INTO role (name, "roleType", "accessMenu", "createdAt") VALUES ('SA', 'super_admin', '[]', NOW()), ('A', 'admin', '[]', NOW())`)
    await runUp('20260810000002-add-goods-request-menu-access.js')
    await runUp('20260810000002-add-goods-request-menu-access.js')
    const rows = await sequelize.query('SELECT "roleType", "accessMenu" FROM role ORDER BY "roleType"', {
      type: sequelize.QueryTypes.SELECT
    })
    for (const r of rows) {
      const count = r.accessMenu.filter((m) => m.menu === 'goods-request').length
      expect(count).toBe(1)
    }
  })

  test('default-roles seed skips pre-existing roles without duplicates', async () => {
    await sequelize.query(`TRUNCATE role`)
    for (const t of ['super_admin', 'admin', 'kasir', 'user']) {
      await sequelize.query(`INSERT INTO role (name, "roleType", "accessMenu", "createdAt") VALUES ($1, $2, '[]', NOW())`, { bind: [`P-${t}`, t] })
    }
    await runUp('20260613000003-insert-default-roles.js')
    const rows = await sequelize.query('SELECT COUNT(*) AS n FROM role', { type: sequelize.QueryTypes.SELECT })
    expect(Number(rows[0].n)).toBe(4)
  })

  // E2-ROLE-CREATEDBY-NULL-SYSTEM: system roles carry createdBy NULL
  // (role.createdBy is an INTEGER User.id reference) and isSystem = true when
  // that column exists. The former 'system' literal failed with "invalid
  // input syntax for type integer" whenever the INSERT path was reached.
  test('default-roles seed inserts all four roles into an empty table with createdBy NULL', async () => {
    await sequelize.query(`TRUNCATE role`)
    await runUp('20260613000003-insert-default-roles.js')
    const rows = await sequelize.query('SELECT "roleType", "createdBy" FROM role ORDER BY "roleType"', {
      type: sequelize.QueryTypes.SELECT
    })
    expect(rows.map((r) => r.roleType)).toEqual(['admin', 'kasir', 'super_admin', 'user'])
    expect(rows.every((r) => r.createdBy === null)).toBe(true)
  })

  test('default-roles seed on the production shape (Phase 27.6) inserts exactly kasir as a system role', async () => {
    await sequelize.query(`TRUNCATE role`)
    await sequelize.query('ALTER TABLE role ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false')
    try {
      // Production 2026-10-05: three system roles (createdBy NULL, isSystem
      // true), one tenant-created role (numeric createdBy, isSystem false),
      // and no kasir role.
      const seed = [
        ['Super Admin', 'super_admin', null, true],
        ['Admin Toko', 'admin', null, true],
        ['Staff/Karyawan', 'user', null, true],
        ['Finance', 'user', 7, false]
      ]
      for (const [name, roleType, createdBy, isSystem] of seed) {
        await sequelize.query(
          `INSERT INTO role (name, "roleType", "accessMenu", status, "createdBy", "isSystem", "createdAt", "updatedAt")
           VALUES ($1, $2, '[]', 'active', $3, $4, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
          { bind: [name, roleType, createdBy, isSystem] }
        )
      }
      const snapshot = async () =>
        sequelize.query('SELECT * FROM role ORDER BY id', { type: sequelize.QueryTypes.SELECT })
      const before = await snapshot()

      await runUp('20260613000003-insert-default-roles.js')
      const after = await snapshot()
      expect(after).toHaveLength(5)
      expect(after.slice(0, 4)).toEqual(before)
      const inserted = after[4]
      expect(inserted.roleType).toBe('kasir')
      expect(inserted.name).toBe('Kasir')
      expect(inserted.createdBy).toBeNull()
      expect(inserted.isSystem).toBe(true)
      expect(inserted.status).toBe('active')

      await runUp('20260613000003-insert-default-roles.js')
      expect(await snapshot()).toEqual(after)
    } finally {
      await sequelize.query('ALTER TABLE role DROP COLUMN IF EXISTS "isSystem"')
    }
  })

  test('default-roles seed carries no string actor in createdBy', () => {
    const source = fs.readFileSync(path.join(__dirname, '../db/migrations/20260613000003-insert-default-roles.js'), 'utf8')
    expect(source).not.toMatch(/createdBy\s*:\s*['"`]/)
    expect((source.match(/createdBy: null,/g) || []).length).toBe(4)
  })

  // E2-ROLE-MIGRATION-DOWN-SAFETY: the seed is forward-only. down() must never
  // delete roles. A roleType predicate is broader than what up() inserted, and
  // user.roleId is ON DELETE CASCADE (production and dev schema), so a
  // destructive down() would also delete users.
  const DEFAULT_ROLES = '20260613000003-insert-default-roles.js'
  const seedRepresentativeRoles = async () => {
    await sequelize.query(`TRUNCATE role`)
    const roles = [
      ['Super Admin', 'super_admin', null],
      ['Admin Toko', 'admin', null],
      ['Kasir', 'kasir', null],
      ['Staff/Karyawan', 'user', null],
      ['Finance', 'user', 7] // tenant-created role sharing a seeded roleType
    ]
    for (const [name, roleType, createdBy] of roles) {
      await sequelize.query(
        `INSERT INTO role (name, "roleType", "accessMenu", status, "createdBy", "createdAt", "updatedAt")
         VALUES ($1, $2, '[]', 'active', $3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        { bind: [name, roleType, createdBy] }
      )
    }
    // Production-shaped reference: user.roleId -> role(id) ON DELETE CASCADE.
    await sequelize.query('ALTER TABLE "user" ADD COLUMN "roleId" INTEGER REFERENCES role(id) ON DELETE CASCADE')
    await sequelize.query(
      `INSERT INTO "user" ("roleId", "updatedAt")
       SELECT id, '2026-01-01T00:00:00Z' FROM role WHERE name IN ('Super Admin', 'Finance')`
    )
  }
  const cleanupRepresentativeRoles = async () => {
    await sequelize.query('ALTER TABLE "user" DROP COLUMN IF EXISTS "roleId"')
    await sequelize.query(`DELETE FROM "user" WHERE "updatedAt" = '2026-01-01T00:00:00Z'`)
    await sequelize.query(`TRUNCATE role`)
  }
  const roleState = () => sequelize.query('SELECT * FROM role ORDER BY id', { type: sequelize.QueryTypes.SELECT })
  const userRefs = () =>
    sequelize.query('SELECT id, "roleId" FROM "user" WHERE "roleId" IS NOT NULL ORDER BY id', {
      type: sequelize.QueryTypes.SELECT
    })
  // Records every queryInterface / sequelize.query call made through it.
  const recordingQi = (calls) => {
    const base = qi()
    const seq = new Proxy(base.sequelize, {
      get(target, prop) {
        const value = target[prop]
        if (prop === 'query') return (...args) => (calls.push(`sequelize.query: ${String(args[0]).slice(0, 80)}`), value.apply(target, args))
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    return new Proxy(base, {
      get(target, prop) {
        if (prop === 'sequelize') return seq
        const value = target[prop]
        if (typeof value === 'function') return (...args) => (calls.push(`queryInterface.${String(prop)}`), value.apply(target, args))
        return value
      }
    })
  }

  test('default-roles down() is non-destructive: no role or referencing user is deleted, no query is issued', async () => {
    await seedRepresentativeRoles()
    try {
      const rolesBefore = await roleState()
      const usersBefore = await userRefs()
      expect(rolesBefore).toHaveLength(5)
      expect(usersBefore).toHaveLength(2)

      const calls = []
      await require(`../db/migrations/${DEFAULT_ROLES}`).down(recordingQi(calls), require('sequelize'))

      expect(calls).toEqual([])
      expect(await roleState()).toEqual(rolesBefore)
      expect(await userRefs()).toEqual(usersBefore)
    } finally {
      await cleanupRepresentativeRoles()
    }
  })

  test('default-roles down() then up() leaves seeded-role state intact and inserts no duplicate', async () => {
    await seedRepresentativeRoles()
    try {
      const rolesBefore = await roleState()
      const usersBefore = await userRefs()

      await require(`../db/migrations/${DEFAULT_ROLES}`).down(qi(), require('sequelize'))
      expect(await roleState()).toEqual(rolesBefore)

      await runUp(DEFAULT_ROLES)
      const rolesAfter = await roleState()
      expect(rolesAfter).toEqual(rolesBefore)
      const seeded = rolesAfter.filter((r) => r.createdBy === null).map((r) => r.roleType)
      expect(seeded.sort()).toEqual(['admin', 'kasir', 'super_admin', 'user'])
      expect(await userRefs()).toEqual(usersBefore)
    } finally {
      await cleanupRepresentativeRoles()
    }
  })

  test('default-roles down() contains no destructive statement', () => {
    const downSource = require(`../db/migrations/${DEFAULT_ROLES}`).down.toString()
    // Executable code only (line comments explain the no-op and may name the hazard).
    const code = downSource.replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/bulkDelete|destroy|\bDELETE\b|TRUNCATE|DROP\b|roleType|queryInterface\./i)
    // The function body is comments only: no executable statement remains.
    expect(code.slice(code.indexOf('{') + 1, code.lastIndexOf('}')).trim()).toBe('')
  })
})

describe('W-02R.4 runner rerun convergence (disposable database)', () => {
  const DB = `cashier_app_staging_rehearsal_rerun_${process.pid}`
  test('db:migrate with a complete ledger executes nothing', async () => {
    const saved = process.env.STAGING_DB_DATABASE
    process.env.STAGING_DB_DATABASE = DB
    const admin = harness.stagingConnection({ database: DB })
    let sequelize = null
    try {
      await harness.createDatabase(admin, DB)
      sequelize = harness.newSequelize({ ...admin, database: DB })
      await sequelize.query('CREATE TABLE "SequelizeMeta" (name VARCHAR(255) NOT NULL PRIMARY KEY)')
      const values = FILES.map((_, i) => `($${i + 1})`).join(', ')
      await sequelize.query(`INSERT INTO "SequelizeMeta" (name) VALUES ${values}`, { bind: [...FILES] })
      await sequelize.close()
      sequelize = null
      const cli = require.resolve('sequelize-cli/lib/sequelize')
      const child = spawnSync(process.execPath, [cli, 'db:migrate', '--env', 'staging'], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'staging' }
      })
      expect(child.status).toBe(0)
      expect(child.stdout).not.toMatch(/== .* : migrating/)
    } finally {
      if (sequelize) await sequelize.close().catch(() => {})
      await harness.dropDatabase(admin, DB).catch(() => {})
      if (saved === undefined) delete process.env.STAGING_DB_DATABASE
      else process.env.STAGING_DB_DATABASE = saved
    }
  }, 180000)
})

describe('W-02R.4 full rehearsal integration (disposable database)', () => {
  const DB = `cashier_app_staging_rehearsal_e2e_${process.pid}`.replace(/-/g, '_')
  let evidenceDir = null
  let manifestPath = null
  let sha = null

  beforeAll(() => {
    const psql = spawnSync('psql', ['--version'], { encoding: 'utf8' })
    if (psql.status !== 0) throw new Error('psql is required for the rehearsal integration test')
    evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w02r4-evidence-'))
    manifestPath = path.join(evidenceDir, 'staging.approved.json')
    const approved = { ...STAGING_MANIFEST(), approvedBy: 'w02r4-integration-test', approvedAt: '2026-10-03T00:00:00Z' }
    fs.writeFileSync(manifestPath, JSON.stringify(approved, null, 2))
    sha = rules.sha256OfFile(manifestPath)
  }, 60000)

  test('dry-run validates without touching any database', async () => {
    const code = await harness.main([`--staging-db=cashier_app_staging_rehearsal_dryrun_${process.pid}`, `--manifest=${manifestPath}`])
    expect(code).toBe(0)
  })

  test('full lifecycle passes with decisions isolated (expected-BLOCKED)', async () => {
    const code = await harness.main([
      `--staging-db=${DB}`,
      `--manifest=${manifestPath}`,
      '--apply',
      `--authorize-manifest-sha256=${sha}`,
      `--evidence-dir=${evidenceDir}`
    ])
    expect(code).toBe(0)
    const files = fs.readdirSync(evidenceDir).filter((f) => f.startsWith('w02r4-rehearsal-') && f.endsWith('.json'))
    expect(files).toHaveLength(1)
    const ev = JSON.parse(fs.readFileSync(path.join(evidenceDir, files[0]), 'utf8'))
    expect(ev.result).toBe('rehearsal-pass-blocked')
    expect(ev.target).toBe('staging')
    expect(ev.stagingDb).toBe(DB)
    expect(ev.steps.plan.e2Candidates).toHaveLength(20)
    expect(ev.steps.stamp.inserted).toHaveLength(197)
    expect(ev.steps.e2.executed).toHaveLength(20)
    expect(ev.steps.e2.missingAfterRun).toEqual([])
    // D-05: the snapshot's target indexes are dropped before E2 (production
    // has member_pkey only), so the D-05 migration genuinely creates them.
    expect(ev.steps.fixture.driftDownD05Indexes.sort()).toEqual([...harness.D05_MEMBER_INDEXES].sort())
    expect(ev.steps.e2.executed).toContainEqual(
      expect.objectContaining({ migration: '20261012000001-d05-member-identity-uniqueness.js', status: 0 })
    )
    // P1 attribution foundation: the four additive migrations execute
    // cleanly in rehearsal (M2 orphan preflight passes on fixture data;
    // M3 CHECK is NOT VALID so legacy alias rows do not block it).
    for (const migration of [
      '20261013000001-p1-transaction-attribution.js',
      '20261013000002-p1-transaction-linkage-fks.js',
      '20261013000004-p1-register-close-snapshot.js',
      '20261013000005-p1-canonical-payment-check.js'
    ]) {
      expect(ev.steps.e2.executed).toContainEqual(expect.objectContaining({ migration, status: 0 }))
    }
    expect(ev.steps.d05Indexes.present.sort()).toEqual([...harness.D05_MEMBER_INDEXES].sort())
    expect(ev.steps.d05Indexes.missing).toEqual([])
    expect(ev.steps.verify.metaCount).toBe(243)
    expect(ev.steps.verify.failures).toEqual([])
    expect(ev.steps.verify.status).toBe('BLOCKED')
    expect(ev.steps.verify.blocked).toHaveLength(3)
    expect(sortBlocked(ev.steps.verify.blocked)).toEqual(EXPECTED_STAGING_BLOCKED)
    expect(ev.steps.verify.data.splitBillNullStatus).toBe(0)
    expect(ev.steps.verify.data.metaDuplicates).toBe(0)
    expect(ev.steps.verify.data.metaOrphans).toEqual([])
    expect(ev.steps.e2.nonExecutionProofs.showLogoPresent).toBe(true)
    expect(ev.steps.e2.nonExecutionProofs.expenseCategoryDefaultIntact).toBe(true)
    expect(ev.steps.e2.nonExecutionProofs.e2MenuAppendsPresent).toBe(true)
    expect(ev.steps.e2.nonExecutionProofs.probeUserMyShift).toBe(true)
    expect(JSON.stringify(ev)).not.toMatch(/PGPASSWORD|password/i)
  }, 300000)

  test('rehearsal database was dropped by cleanup', async () => {
    const { Sequelize } = require('sequelize')
    const admin = new Sequelize('postgres', process.env.STAGING_DB_USER || 'postgres', process.env.STAGING_DB_PASSWORD, {
      host: process.env.STAGING_DB_HOST || '127.0.0.1',
      port: process.env.STAGING_DB_PORT || 5432,
      dialect: 'postgres',
      logging: false
    })
    try {
      const rows = await admin.query(`SELECT 1 FROM pg_database WHERE datname = '${DB}'`, { type: admin.QueryTypes.SELECT })
      expect(rows).toHaveLength(0)
    } finally {
      await admin.close().catch(() => {})
    }
  })
})
