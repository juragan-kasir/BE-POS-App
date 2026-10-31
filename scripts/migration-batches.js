'use strict'

/**
 * D-08 E2 Option C — bounded migration batch contract.
 *
 * The E2 inventory (migrations meant to run through the normal runner; see
 * db/migration-dispositions/README.md) is executed in separately approved,
 * contiguous batches instead of one unbounded `db:migrate`:
 *
 *   B1  the original 13 E2 migrations (includes 20261011000001, whose effect
 *       already exists in production via D-08-EXC-01; its guard makes it a
 *       no-op and the runner records it normally)
 *   B2  P1 foundation: M1 attribution, M2 linkage FKs, M5 close snapshot
 *   B3  M3 canonical typePayment CHECK — only after P1 code is live and
 *       canonical payment writes are verified (a5deb07 writes non-canonical
 *       values such as 'cash', which the CHECK would refuse)
 *
 * Record: docs/superpowers/evidence/d08-e2-batch-contract-record.md.
 *
 * This module is a pure decision. It never connects to a database and never
 * writes SequelizeMeta; scripts/run-migrations.js consumes it after the D-08
 * preflight (scripts/check-migration-preflight.js) has passed. Batch members
 * are exact filenames — there is no free-form range and no arbitrary
 * filename execution.
 *
 * openGates are governance gates the runner refuses on. Clearing one is a
 * reviewed change to this file that cites the decision/evidence; existing in
 * the repository never approves a batch for execution on its own.
 */

const deepFreeze = (batch) =>
  Object.freeze({
    ...batch,
    migrations: Object.freeze([...batch.migrations]),
    openGates: Object.freeze(batch.openGates.map((g) => Object.freeze({ ...g })))
  })

const E2_BATCHES = Object.freeze({
  B1: deepFreeze({
    id: 'B1',
    title: 'Original E2 #1–#13',
    expectedCount: 13,
    migrations: [
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
      '20261012000001-d05-member-identity-uniqueness.js'
    ],
    // DR-22: RESOLVED 2026-10-07 by Product Owner CONDITIONAL AUTHORIZATION
    // (docs/superpowers/evidence/dr22-conditional-authorization-record.md;
    // intent dr22-condition1-intent-record-2026-10-07.md; role-state
    // dr22-condition-recapture-2026-10-07T18-14-37Z.md). Gate clearance makes
    // B1 governance-eligible only: B1 execution still needs its own explicit
    // approval plus, per the D-08 record and RELEASING.md, an execution-time
    // restore point and fresh read-only preconditions.
    openGates: []
  }),
  B2: deepFreeze({
    id: 'B2',
    title: 'P1 foundation: M1 + M2 + M5',
    expectedCount: 3,
    migrations: [
      '20261013000001-p1-transaction-attribution.js',
      '20261013000002-p1-transaction-linkage-fks.js',
      '20261013000004-p1-register-close-snapshot.js'
    ],
    openGates: []
  }),
  B3: deepFreeze({
    id: 'B3',
    title: 'P1 M3 canonical payment CHECK',
    expectedCount: 1,
    migrations: ['20261013000005-p1-canonical-payment-check.js'],
    // P1-CANONICAL-WRITES-VERIFIED: RESOLVED 2026-10-08 by formal gate
    // review (docs/superpowers/evidence/d08-b3-gate-review-record.md:
    // P1 canonical build f80ef8e live in production; CASH order #26 /
    // E_WALLET order #27 persisted canonically with reconciled side
    // effects; 154 green automated tests). Gate clearance makes B3
    // governance-eligible only: execution still needs its own explicit
    // authorization plus, per the D-08 record and RELEASING.md, an
    // execution-time restore point and fresh read-only preconditions.
    openGates: []
  }),
  B4: deepFreeze({
    id: 'B4',
    title: 'post-P1 additive schema hardening',
    expectedCount: 2,
    migrations: [
      '20261016210748-add-stock-posted-to-goods-receipt.js',
      '20261023000001-harden-audit-log.js'
    ],
    // Two schema-only additive migrations: the stockPosted flag (guarded
    // add-if-missing BOOLEAN, default TRUE preserves post-at-create
    // accounting) and the auditLog DB backstop (tenantId backfill + FK +
    // append-only triggers). Both replay safely. No governance gate: no
    // business-data decision and no destructive rewrite.
    openGates: []
  }),
  B5: deepFreeze({
    id: 'B5',
    title: 'DR-28 field-length widening',
    expectedCount: 1,
    migrations: ['20261024000001-dr28-widen-text-columns.js'],
    // BA DR-28 step 4: widen tenant.name, table.area, stock_transfer.reason
    // and the URL/image/path columns to the field-length standard. Widening
    // a VARCHAR is catalog-only; nothing is narrowed or rewritten, and the
    // migration replays safely. No governance gate: the decision is DR-28
    // (product owner, 2026-10-24) and no business data changes.
    openGates: []
  }),
  B6: deepFreeze({
    id: 'B6',
    title: 'DR-28 minOrderQty as a whole number',
    expectedCount: 1,
    migrations: ['20261025000001-dr28-min-order-qty-integer.js'],
    // BA DR-28 decision 4: supplier_product.minOrderQty VARCHAR(50) ->
    // INTEGER. Fails closed before any DDL when a value is not digits only
    // (nothing is guessed or rewritten); replays safely. No governance gate:
    // the decision is DR-28 (product owner, 2026-10-24).
    openGates: []
  }),
  B7: deepFreeze({
    id: 'B7',
    title: 'D-05 amendment A1: member phone/email unique per store',
    expectedCount: 1,
    migrations: ['20261031000001-member-phone-email-store-scoped.js'],
    // D-05 amendment A1 (product owner, 2026-10-31; record
    // docs/superpowers/evidence/d05-member-identity-contract.md §7): the
    // global phone/email unique indexes become per store bucket, like names.
    // up only relaxes uniqueness, so existing rows always satisfy it and no
    // data is rewritten; down aborts before any DDL when rows now share a
    // phone or email across stores. No governance gate.
    openGates: []
  })
})

const BATCH_ORDER = Object.freeze(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'])

// D-08 B1 resume contracts. A resume finishes a batch whose earlier members
// were recorded by an interrupted run; it never redefines the batch (the
// frozen B1 list above is the single source of membership). Each resume pins
// the exact incident ledger it may continue from and the ledger it must leave.
//
// B1-D05: on 2026-10-08 the production B1 run recorded B1 #1–#12 normally and
// D-05 aborted in its own preflight P1 (`unparseable active phone values
// (count=4)`, fail closed: no DDL, no rewrite). SequelizeMeta = 223 + 12 = 235.
// Record: docs/superpowers/evidence/d08-b1-d05-resume-record.md.
const deepFreezeResume = (resume) =>
  Object.freeze({
    ...resume,
    migrations: Object.freeze([...resume.migrations]),
    openGates: Object.freeze(resume.openGates.map((g) => Object.freeze({ ...g })))
  })

const BATCH_RESUMES = Object.freeze({
  'B1-D05': deepFreezeResume({
    id: 'B1-D05',
    batch: 'B1',
    title: 'B1 resume: D-05 only, after the 2026-10-08 D-05 preflight abort',
    recordedCount: 12,
    migrations: ['20261012000001-d05-member-identity-uniqueness.js'],
    ledgerBefore: 235,
    ledgerAfter: 236,
    postconditions: 'D05_MEMBER_IDENTITY',
    // D05-AFFECTED-ROWS-DISPOSITIONED: RESOLVED 2026-10-08 by formal gate
    // review (docs/superpowers/evidence/d08-b1-d05-gate-review-record.md:
    // owner TEST dispositions for all four affected rows, authorized full
    // reset superseding per-row verification, 9+9 live fixture lifecycle,
    // clean M08 recapture, 184 green automated tests). Gate clearance makes
    // B1-D05 governance-eligible only: execution still needs its own explicit
    // authorization plus, per the D-08 record and RELEASING.md, an
    // execution-time restore point and fresh read-only preconditions.
    openGates: []
  })
})

// D-05 postconditions, as PostgreSQL renders them in pg_indexes.indexdef
// (contract record d05-member-identity-contract.md §3.2): the four partial
// unique indexes exist on public.member with their expressions and
// predicates, no superseded historical member uniqueness object survives,
// and the backfill left no active non-guest phone outside E.164 form.
// Fragments (not whole strings) are matched, as in the D-05 migration test,
// so the check does not depend on the server's exact deparse formatting;
// the runner records the observed definitions verbatim as evidence.
const D05_TARGET_INDEXES = Object.freeze({
  uq_member_store_name_ci: Object.freeze(['(store, lower(TRIM(BOTH FROM name)))', '(store IS NOT NULL)', '("deletedAt" IS NULL)']),
  uq_member_global_name_ci: Object.freeze(['(lower(TRIM(BOTH FROM name)))', '(store IS NULL)', '("deletedAt" IS NULL)']),
  uq_member_phone_e164: Object.freeze(['("phoneNumber")', '("deletedAt" IS NULL)', "((\"phoneNumber\")::text !~~ 'GUEST-%'::text)"]),
  uq_member_email_ci: Object.freeze(['(lower(TRIM(BOTH FROM email)))', '("deletedAt" IS NULL)', '(email IS NOT NULL)'])
})
const D05_HISTORICAL_OBJECTS = Object.freeze([
  'uq_member_name',
  'uq_member_phoneNumber',
  'uq_member_email',
  'uq_member_store_name',
  'uq_member_global_name'
])

function verifyD05MemberIdentity(state) {
  const indexDefs = state && state.indexDefs
  const constraintNames = state && state.constraintNames
  const nonCanonical = state && state.nonCanonicalActivePhones
  if (!indexDefs || typeof indexDefs !== 'object' || !Array.isArray(constraintNames) || !Number.isInteger(nonCanonical)) {
    return { ok: false, failures: ['member index/constraint/phone state unavailable'] }
  }
  const failures = []
  for (const [name, fragments] of Object.entries(D05_TARGET_INDEXES)) {
    const def = indexDefs[name]
    if (typeof def !== 'string') {
      failures.push(`index ${name} missing`)
      continue
    }
    if (!def.startsWith('CREATE UNIQUE INDEX ')) failures.push(`index ${name} is not UNIQUE`)
    for (const f of ['ON public.member USING btree ', ...fragments]) {
      if (!def.includes(f)) failures.push(`index ${name} definition lacks "${f}"`)
    }
  }
  for (const name of D05_HISTORICAL_OBJECTS) {
    if (Object.prototype.hasOwnProperty.call(indexDefs, name) || constraintNames.includes(name)) {
      failures.push(`historical ${name} still present`)
    }
  }
  if (nonCanonical !== 0) failures.push(`${nonCanonical} active non-guest phone(s) not in E.164 form`)
  return { ok: failures.length === 0, failures }
}

const POSTCONDITIONS = Object.freeze({ D05_MEMBER_IDENTITY: verifyD05MemberIdentity })
const D05_TARGET_INDEX_NAMES = Object.freeze(Object.keys(D05_TARGET_INDEXES))

// B3 execution guards. M3 adds a CHECK constraint, which takes an ACCESS
// EXCLUSIVE lock on "transaction" (blocks reads and writes while held or
// queued), so the B3 run is bounded server-side and verified afterwards.
//
// Session guard: the spawned sequelize-cli process (and only that process)
// gets lock_timeout / statement_timeout / application_name through the pg
// driver's PGOPTIONS / PGAPPNAME environment fallback (pg 8.x reads them
// only when the connection config sets no `options` / `application_name`;
// config/config.js sets neither). A pooler may reject or silently drop
// startup options, so the runner proves the values are in effect on the
// target endpoint (read-only probe) before it starts the migration.
const BATCH_SESSION_GUARDS = Object.freeze({
  B3: Object.freeze({ lockTimeoutMs: 3000, statementTimeoutMs: 60000, applicationName: 'd08-b3-m3' })
})

// Transaction-scoped advisory lock serializing guarded D-08 runs (B3).
// Transaction-scoped (not session-scoped) so a transaction-mode pooler can
// never strand it on a pooled server connection. Fixed, namespaced 64-bit
// key (two 32-bit halves) derived from 'd08-batch-runner/v1', following the
// CAP-003 precedent (scripts/controlled-apply-production.js advisoryLockKeys).
const D08_RUNNER_LOCK_KEYS = (() => {
  const h = require('crypto').createHash('sha256').update('d08-batch-runner/v1').digest()
  return Object.freeze([h.readInt32BE(0), h.readInt32BE(4)])
})()

function sessionEnv(guard) {
  return {
    PGOPTIONS: `-c lock_timeout=${guard.lockTimeoutMs} -c statement_timeout=${guard.statementTimeoutMs}`,
    PGAPPNAME: guard.applicationName
  }
}

// `observed` is what the target server reports for a connection opened with
// sessionEnv(guard): { lockTimeoutMs, statementTimeoutMs, applicationName }.
function verifySessionSettings(observed, guard) {
  if (!observed || typeof observed !== 'object') return { ok: false, failures: ['session settings unavailable'] }
  const failures = []
  if (observed.lockTimeoutMs !== guard.lockTimeoutMs) {
    failures.push(`lock_timeout is ${observed.lockTimeoutMs} ms, expected ${guard.lockTimeoutMs} ms`)
  }
  if (observed.statementTimeoutMs !== guard.statementTimeoutMs) {
    failures.push(`statement_timeout is ${observed.statementTimeoutMs} ms, expected ${guard.statementTimeoutMs} ms`)
  }
  if (observed.applicationName !== guard.applicationName) {
    failures.push(`application_name is "${observed.applicationName}", expected "${guard.applicationName}"`)
  }
  return { ok: failures.length === 0, failures }
}

// M3 state contract. The expected constraint is an independent literal —
// never read back from the migration — so neither a drifted migration nor a
// pre-existing same-named constraint (M3's `IF NOT EXISTS` checks the name
// only) can verify itself. PostgreSQL renders `"typePayment" IN (...)` on a
// VARCHAR column as `= ANY (ARRAY[...])` (verified on 14.19 and 17.11); any
// other rendering fails closed.
const M3_MIGRATION = '20261013000005-p1-canonical-payment-check.js'
const M3_CONSTRAINT = Object.freeze({
  name: 'transaction_typepayment_canonical',
  schema: 'public',
  table: 'transaction',
  column: 'typePayment',
  values: Object.freeze(['CASH', 'CARD', 'BANK_TRANSFER', 'E_WALLET', 'QRIS', 'POINTS', 'OTHER'])
})
const M3_DEF_PATTERN = /^CHECK \(\(\("typePayment"\)::text = ANY \(\(ARRAY\[(.+)\]\)::text\[\]\)\)\)( NOT VALID)?$/
const M3_VALUE_PATTERN = /^'([A-Z_]+)'::character varying$/

function parseM3Definition(def) {
  const match = typeof def === 'string' ? M3_DEF_PATTERN.exec(def) : null
  if (!match) return null
  const values = match[1].split(', ').map((item) => {
    const v = M3_VALUE_PATTERN.exec(item)
    return v ? v[1] : null
  })
  if (values.includes(null)) return null
  return { values, notValid: Boolean(match[2]) }
}

function m3StateAvailable(state) {
  return Boolean(state) && Array.isArray(state.constraints) && Number.isInteger(state.ledgerCount) && Boolean(state.column)
}

// M3 relies on "typePayment" being NOT NULL (a CHECK passes NULL). `column`
// is the catalog view of exactly public.transaction("typePayment"):
// { relation: 'public.transaction' | null, relkind, matches, notNull }.
function m3ColumnFailures(column) {
  if (!column || typeof column !== 'object') return ['public.transaction("typePayment") state unavailable']
  if (column.relation !== `${M3_CONSTRAINT.schema}.${M3_CONSTRAINT.table}`) return ['relation public.transaction not found']
  if (column.relkind !== 'r' && column.relkind !== 'p') return [`public.transaction is not a table (relkind ${column.relkind})`]
  if (column.matches !== 1) return [`column "${M3_CONSTRAINT.column}" found ${column.matches} time(s) on public.transaction, expected exactly 1`]
  if (column.notNull !== true) return [`column "${M3_CONSTRAINT.column}" is not NOT NULL (attnotnull ${column.notNull}); M3 relies on it`]
  return []
}

// Before B3 spawns: public.transaction("typePayment") exists and is NOT
// NULL, no same-named constraint exists anywhere, and M3 is unrecorded.
// A pre-existing constraint is never adopted (M3 would skip it and record
// the ledger over an unverified definition).
function verifyM3Absent(state) {
  if (!m3StateAvailable(state)) return { ok: false, failures: ['M3 constraint/ledger state unavailable'] }
  const failures = m3ColumnFailures(state.column)
  if (state.constraints.length) {
    failures.push(`constraint ${M3_CONSTRAINT.name} already exists (${state.constraints.length}) — inspect its definition independently; B3 never adopts a pre-existing constraint`)
  }
  if (state.ledgerCount !== 0) failures.push(`SequelizeMeta already records ${M3_MIGRATION} (${state.ledgerCount})`)
  return { ok: failures.length === 0, failures }
}

// After B3 returns: the column is still NOT NULL, and there is exactly one
// CHECK on public.transaction("typePayment"),
// exactly the seven canonical values, NOT VALID (convalidated = false; the
// VALIDATE step is M6), and M3 recorded exactly once.
function verifyM3CanonicalCheck(state) {
  if (!m3StateAvailable(state)) return { ok: false, failures: ['M3 constraint/ledger state unavailable'] }
  const failures = m3ColumnFailures(state.column)
  if (state.ledgerCount !== 1) failures.push(`SequelizeMeta records ${M3_MIGRATION} ${state.ledgerCount} time(s), expected exactly 1`)
  if (state.constraints.length !== 1) {
    failures.push(`expected exactly one constraint named ${M3_CONSTRAINT.name}, found ${state.constraints.length}`)
    return { ok: false, failures }
  }
  const c = state.constraints[0]
  if (c.schema !== M3_CONSTRAINT.schema || c.table !== M3_CONSTRAINT.table) {
    failures.push(`constraint is on ${c.schema}.${c.table}, expected ${M3_CONSTRAINT.schema}.${M3_CONSTRAINT.table}`)
  }
  if (c.contype !== 'c') failures.push(`constraint type is "${c.contype}", expected CHECK ("c")`)
  if (!Array.isArray(c.columns) || c.columns.length !== 1 || c.columns[0] !== M3_CONSTRAINT.column) {
    failures.push(`constraint columns are ${JSON.stringify(c.columns)}, expected ["${M3_CONSTRAINT.column}"]`)
  }
  if (c.convalidated !== false) failures.push(`convalidated is ${c.convalidated}, expected false (NOT VALID; VALIDATE is M6)`)
  const parsed = parseM3Definition(c.def)
  if (!parsed) {
    failures.push(`definition does not match the canonical CHECK shape: ${c.def}`)
  } else {
    if (!parsed.notValid) failures.push('definition is not NOT VALID')
    const expected = M3_CONSTRAINT.values
    const unexpected = parsed.values.filter((v) => !expected.includes(v))
    const missing = expected.filter((v) => !parsed.values.includes(v))
    if (unexpected.length) failures.push(`definition allows non-canonical value(s): ${unexpected.join(', ')}`)
    if (missing.length) failures.push(`definition lacks canonical value(s): ${missing.join(', ')}`)
    if (new Set(parsed.values).size !== parsed.values.length) failures.push('definition lists a value more than once')
  }
  return { ok: failures.length === 0, failures }
}

// Batches whose run is bracketed by read-only state checks.
const BATCH_STATE_CHECKS = Object.freeze({
  B3: Object.freeze({ id: 'M3_CANONICAL_CHECK', before: verifyM3Absent, after: verifyM3CanonicalCheck })
})

function validateResumeDefinition(resume, batches = E2_BATCHES) {
  const errors = []
  const batch = resume && Object.prototype.hasOwnProperty.call(batches, resume.batch) ? batches[resume.batch] : null
  if (!batch) return [`unknown base batch "${resume && resume.batch}"`]
  for (const e of validateBatchDefinition(batch)) errors.push(`base batch ${batch.id}: ${e}`)
  const list = Array.isArray(resume.migrations) ? resume.migrations : []
  if (list.length === 0) errors.push('resume lists no migrations')
  if (!Number.isInteger(resume.recordedCount) || resume.recordedCount + list.length !== batch.migrations.length) {
    errors.push(`recordedCount ${resume.recordedCount} + ${list.length} resume member(s) must equal the ${batch.migrations.length} members of ${batch.id}`)
  }
  const suffix = batch.migrations.slice(batch.migrations.length - list.length)
  if (list.length === 0 || list.some((m, i) => m !== suffix[i])) {
    errors.push(`resume members must be exactly the last ${list.length} member(s) of ${batch.id} (suffix), in order`)
  }
  if (!Number.isInteger(resume.ledgerBefore) || resume.ledgerAfter !== resume.ledgerBefore + list.length) {
    errors.push(`ledgerAfter ${resume.ledgerAfter} must equal ledgerBefore ${resume.ledgerBefore} + ${list.length}`)
  }
  if (!Object.prototype.hasOwnProperty.call(POSTCONDITIONS, resume.postconditions)) {
    errors.push(`unknown postcondition check "${resume.postconditions}"`)
  }
  return errors
}

// Decides whether `sequelize-cli db:migrate --to <to>` would execute exactly
// the resume members from exactly the pinned incident ledger: the batch
// prefix is fully recorded, no resume member is recorded, the ledger has the
// pinned row count with no duplicates, the pending list starts with exactly
// the resume members, and no governance gate is open.
function evaluateResume({ resumeId, files, metaNames, batches = E2_BATCHES, resumes = BATCH_RESUMES }) {
  const resume = Object.prototype.hasOwnProperty.call(resumes, resumeId) ? resumes[resumeId] : null
  if (!resume) return { ok: false, reasons: [`unknown resume "${resumeId}" (known: ${Object.keys(resumes).join(', ')})`] }
  const reasons = validateResumeDefinition(resume, batches).map((e) => `resume ${resumeId}: ${e}`)
  if (!Array.isArray(files) || !Array.isArray(metaNames)) {
    reasons.push(`resume ${resumeId}: repository files or SequelizeMeta state unavailable`)
    return { ok: false, reasons, resume }
  }
  if (reasons.length === 0) {
    const batch = batches[resume.batch]
    const prefix = batch.migrations.slice(0, resume.recordedCount)
    const fileSet = new Set(files)
    const recorded = new Set(metaNames)
    if (recorded.size !== metaNames.length) reasons.push(`resume ${resumeId}: SequelizeMeta contains duplicate names`)
    const missing = batch.migrations.filter((m) => !fileSet.has(m))
    if (missing.length) reasons.push(`resume ${resumeId}: missing migration file(s): ${missing.join(', ')}`)
    const notRecorded = prefix.filter((m) => !recorded.has(m))
    if (notRecorded.length) {
      reasons.push(`resume ${resumeId}: expected recorded ${batch.id} member(s) not recorded: ${notRecorded.join(', ')}`)
    }
    const already = resume.migrations.filter((m) => recorded.has(m))
    if (already.length) reasons.push(`resume ${resumeId}: already recorded in SequelizeMeta: ${already.join(', ')}`)
    if (metaNames.length !== resume.ledgerBefore) {
      reasons.push(`resume ${resumeId}: SequelizeMeta has ${metaNames.length} row(s); the ${resumeId} resume requires exactly ${resume.ledgerBefore} (verified incident state)`)
    }
    if (reasons.length === 0) {
      const pending = [...files].sort().filter((f) => !recorded.has(f))
      const to = resume.migrations[resume.migrations.length - 1]
      const window = pending.slice(0, pending.indexOf(to) + 1)
      const outside = window.filter((f) => !resume.migrations.includes(f))
      if (outside.length) {
        reasons.push(`resume ${resumeId}: pending migration(s) outside ${resumeId} would run first: ${outside.join(', ')}`)
      } else if (window.length !== resume.migrations.length) {
        reasons.push(`resume ${resumeId}: would execute ${window.length} migrations, expected ${resume.migrations.length}`)
      }
    }
  }
  for (const gate of resume.openGates) reasons.push(`resume ${resumeId}: open governance gate ${gate.id} — ${gate.reason}`)
  if (reasons.length) return { ok: false, reasons, resume }
  return {
    ok: true,
    reasons: [],
    resume,
    migrations: [...resume.migrations],
    to: resume.migrations[resume.migrations.length - 1],
    ledgerAfter: resume.ledgerAfter
  }
}

function validateBatchDefinition(batch) {
  const errors = []
  const list = Array.isArray(batch?.migrations) ? batch.migrations : []
  if (list.length === 0) errors.push('contract lists no migrations')
  if (list.some((m) => typeof m !== 'string' || !m.endsWith('.js'))) errors.push('contract entries must be migration filenames')
  for (let i = 1; i < list.length; i++) {
    if (!(list[i - 1] < list[i])) {
      errors.push(`contract is not strictly ascending in filename order at ${list[i - 1]} → ${list[i]}`)
      break
    }
  }
  if (batch?.expectedCount !== list.length) {
    errors.push(`expected ${batch?.expectedCount} migrations, contract lists ${list.length}`)
  }
  return errors
}

// Decides whether `sequelize-cli db:migrate --to <to>` would execute exactly
// this batch: every member exists, none is recorded yet, the pending list
// (files − SequelizeMeta, filename order) starts with exactly these members,
// and no governance gate is open.
function evaluateBatch({ batchId, files, metaNames, batches = E2_BATCHES, resumes = BATCH_RESUMES }) {
  const batch = Object.prototype.hasOwnProperty.call(batches, batchId) ? batches[batchId] : null
  if (!batch) return { ok: false, reasons: [`unknown batch "${batchId}" (known: ${Object.keys(batches).join(', ')})`] }
  const reasons = validateBatchDefinition(batch).map((e) => `batch ${batchId}: ${e}`)
  if (!Array.isArray(files) || !Array.isArray(metaNames)) {
    reasons.push(`batch ${batchId}: repository files or SequelizeMeta state unavailable`)
    return { ok: false, reasons, batch }
  }
  const fileSet = new Set(files)
  const recorded = new Set(metaNames)
  const missing = batch.migrations.filter((m) => !fileSet.has(m))
  if (missing.length) reasons.push(`batch ${batchId}: missing migration file(s): ${missing.join(', ')}`)
  const already = batch.migrations.filter((m) => recorded.has(m))
  if (already.length) {
    const resumeIds = Object.keys(resumes).filter((id) => resumes[id].batch === batchId)
    const hint = resumeIds.length
      ? `; a partially recorded batch continues only through its reviewed resume contract (--resume ${resumeIds.join(' | ')})`
      : ''
    reasons.push(`batch ${batchId}: already recorded in SequelizeMeta (unexpected ledger state): ${already.join(', ')}${hint}`)
  }
  if (reasons.length === 0) {
    const pending = [...files].sort().filter((f) => !recorded.has(f))
    const members = new Set(batch.migrations)
    const to = batch.migrations[batch.migrations.length - 1]
    const window = pending.slice(0, pending.indexOf(to) + 1)
    const outside = window.filter((f) => !members.has(f))
    if (outside.length) {
      reasons.push(`batch ${batchId}: pending migration(s) outside batch ${batchId} would run first: ${outside.join(', ')}`)
    } else if (window.length !== batch.expectedCount) {
      reasons.push(`batch ${batchId}: would execute ${window.length} migrations, expected ${batch.expectedCount}`)
    }
  }
  for (const gate of batch.openGates) reasons.push(`batch ${batchId}: open governance gate ${gate.id} — ${gate.reason}`)
  if (reasons.length) return { ok: false, reasons, batch }
  return { ok: true, reasons: [], batch, migrations: [...batch.migrations], to: batch.migrations[batch.migrations.length - 1] }
}

function pendingBatchMembers({ files, metaNames, batches = E2_BATCHES }) {
  const recorded = new Set(metaNames)
  const fileSet = new Set(files)
  const out = []
  for (const id of Object.keys(batches)) {
    for (const migration of batches[id].migrations) {
      if (fileSet.has(migration) && !recorded.has(migration)) out.push({ batch: id, migration })
    }
  }
  return out.sort((a, b) => (a.migration < b.migration ? -1 : 1))
}

// Post-run check: the runner must have recorded exactly the batch.
function verifyBatchRecorded({ migrations, before, after }) {
  const was = new Set(before)
  const added = after.filter((n) => !was.has(n))
  const now = new Set(after)
  const unexpected = added.filter((n) => !migrations.includes(n))
  const missing = migrations.filter((m) => !now.has(m))
  return { ok: unexpected.length === 0 && missing.length === 0, added, unexpected, missing }
}

module.exports = {
  E2_BATCHES,
  BATCH_ORDER,
  BATCH_RESUMES,
  POSTCONDITIONS,
  D05_TARGET_INDEX_NAMES,
  BATCH_SESSION_GUARDS,
  BATCH_STATE_CHECKS,
  D08_RUNNER_LOCK_KEYS,
  M3_MIGRATION,
  M3_CONSTRAINT,
  sessionEnv,
  verifySessionSettings,
  parseM3Definition,
  verifyM3Absent,
  verifyM3CanonicalCheck,
  validateBatchDefinition,
  validateResumeDefinition,
  evaluateBatch,
  evaluateResume,
  pendingBatchMembers,
  verifyBatchRecorded
}
