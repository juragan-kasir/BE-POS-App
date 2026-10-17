process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// D-08 E2 Option C — bounded batch contract + batched runner.
// Pure: batches are evaluated from supplied repository files and a supplied
// SequelizeMeta name list, and the runner is exercised with an injected
// preflight, spawn and ledger reader. No database is touched and
// sequelize-cli is never started by these tests.
const fs = require('fs')
const path = require('path')

const batches = require('../scripts/migration-batches')
const runner = require('../scripts/run-migrations')
const preflight = require('../scripts/check-migration-preflight')
const rules = require('../scripts/migration-dispositions')
const harness = require('../scripts/rehearse-staging')
const { discoverMigrationFiles } = require('../scripts/check-production-schema')

const FILES = discoverMigrationFiles()
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations')

const ORIGINAL_E2_13 = [
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
]
const M1 = '20261013000001-p1-transaction-attribution.js'
const M2 = '20261013000002-p1-transaction-linkage-fks.js'
const M5 = '20261013000004-p1-register-close-snapshot.js'
const M3 = '20261013000005-p1-canonical-payment-check.js'
const M3_OLD = '20261013000003-p1-canonical-payment-check.js'
const EXC01 = '20261011000001-add-reactivated-at-to-tenant-membership.js'

const B1 = batches.E2_BATCHES.B1.migrations
const B2 = batches.E2_BATCHES.B2.migrations
const B3 = batches.E2_BATCHES.B3.migrations
const B4 = batches.E2_BATCHES.B4.migrations
const ALL_E2 = [...B1, ...B2, ...B3, ...B4]

// Production-like ledger after stamping: every non-E2 file recorded, plus
// whichever batches the scenario says have already run.
const ledgerWith = (...ran) => FILES.filter((f) => !ALL_E2.includes(f) || ran.flat().includes(f))
// The real contract with every open gate cleared — used only to prove the
// structural range checks independently of the governance gates.
const gatesCleared = () =>
  Object.fromEntries(Object.entries(batches.E2_BATCHES).map(([id, b]) => [id, { ...b, openGates: [] }]))
const withBatch = (id, patch) => ({ ...gatesCleared(), [id]: { ...gatesCleared()[id], ...patch } })

describe('D-08 E2 batch contract (Option C)', () => {
  test('exactly four batches, B1 → B2 → B3 → B4', () => {
    expect(batches.BATCH_ORDER).toEqual(['B1', 'B2', 'B3', 'B4'])
    expect(Object.keys(batches.E2_BATCHES).sort()).toEqual(['B1', 'B2', 'B3', 'B4'])
    expect(Object.isFrozen(batches.E2_BATCHES)).toBe(true)
    for (const id of batches.BATCH_ORDER) {
      expect(Object.isFrozen(batches.E2_BATCHES[id])).toBe(true)
      expect(Object.isFrozen(batches.E2_BATCHES[id].migrations)).toBe(true)
      expect(batches.validateBatchDefinition(batches.E2_BATCHES[id])).toEqual([])
    }
  })

  test('B1 is exactly the original 13 E2 migrations and still contains #12 (D-08-EXC-01)', () => {
    expect(B1).toEqual(ORIGINAL_E2_13)
    expect(batches.E2_BATCHES.B1.expectedCount).toBe(13)
    expect(B1).toContain(EXC01)
  })

  test('B2 is exactly P1 M1 + M2 + M5 and never includes M3', () => {
    expect(B2).toEqual([M1, M2, M5])
    expect(batches.E2_BATCHES.B2.expectedCount).toBe(3)
    expect(B2).not.toContain(M3)
  })

  test('B3 is exactly M3', () => {
    expect(B3).toEqual([M3])
    expect(batches.E2_BATCHES.B3.expectedCount).toBe(1)
  })

  test('B4 is exactly the stockPosted posting flag', () => {
    expect(B4).toEqual(['20261016210748-add-stock-posted-to-goods-receipt.js'])
    expect(batches.E2_BATCHES.B4.expectedCount).toBe(1)
  })

  test('ordering: M1 < M2 < M5 < M3 < B4 in filename (runner) order', () => {
    const order = [M1, M2, M5, M3, ...B4]
    expect([...order].sort()).toEqual(order)
    const idx = order.map((m) => FILES.indexOf(m))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })

  test('B1 + B2 + B3 + B4 covers the derived E2 inventory exactly, in runner order', () => {
    const staging = rules.readDispositionManifest(rules.STAGING_DISPOSITIONS_PATH).manifest
    const { e2 } = harness.deriveRehearsalSets({
      files: FILES,
      manifestNames: staging.migrations.map((r) => r.migration),
      fixtureLedgerNames: harness.fixtureLedgerNames(FILES)
    })
    expect(e2).toEqual(ALL_E2)
    expect(e2).toHaveLength(18)
  })

  test('M3 rename changed ordering only: old name gone, CHECK semantics intact', () => {
    expect(FILES).not.toContain(M3_OLD)
    const src = fs.readFileSync(path.join(MIGRATIONS_DIR, M3), 'utf8')
    expect(src).toMatch(/CHECK \("typePayment" IN/)
    expect(src).toMatch(/NOT VALID/)
    expect(src).toMatch(/'CASH', 'CARD', 'BANK_TRANSFER', 'E_WALLET', 'QRIS', 'POINTS', 'OTHER'/)
    const mig = require(path.join(MIGRATIONS_DIR, M3))
    expect(mig.CONSTRAINT_NAME).toBe('transaction_typepayment_canonical')
  })

  test('B1 gate DR-22 is resolved; B3 gate P1-CANONICAL-WRITES-VERIFIED is resolved; B2 and B4 have none', () => {
    expect(batches.E2_BATCHES.B1.openGates).toEqual([])
    expect(batches.E2_BATCHES.B2.openGates).toEqual([])
    expect(batches.E2_BATCHES.B3.openGates).toEqual([])
    expect(batches.E2_BATCHES.B4.openGates).toEqual([])
  })
})

describe('D-08 E2 batch evaluation (runner safety)', () => {
  test('bounded B1 executes only B1 (to = last B1 migration)', () => {
    const r = batches.evaluateBatch({ batchId: 'B1', files: FILES, metaNames: ledgerWith(), batches: gatesCleared() })
    expect(r.reasons).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.migrations).toEqual(ORIGINAL_E2_13)
    expect(r.to).toBe('20261012000001-d05-member-identity-uniqueness.js')
  })

  test('bounded B2 executes only M1/M2/M5 and stops before M3', () => {
    const r = batches.evaluateBatch({ batchId: 'B2', files: FILES, metaNames: ledgerWith(B1), batches: gatesCleared() })
    expect(r.ok).toBe(true)
    expect(r.migrations).toEqual([M1, M2, M5])
    expect(r.to).toBe(M5)
    expect(r.migrations).not.toContain(M3)
  })

  test('bounded B3 executes only M3', () => {
    const r = batches.evaluateBatch({ batchId: 'B3', files: FILES, metaNames: ledgerWith(B1, B2), batches: gatesCleared() })
    expect(r.ok).toBe(true)
    expect(r.migrations).toEqual([M3])
    expect(r.to).toBe(M3)
  })

  test('cannot cross a batch boundary: a later batch refuses while an earlier one is pending', () => {
    const b2 = batches.evaluateBatch({ batchId: 'B2', files: FILES, metaNames: ledgerWith(), batches: gatesCleared() })
    expect(b2.ok).toBe(false)
    expect(b2.reasons.join('\n')).toMatch(/outside batch B2 .*20260613000003-insert-default-roles\.js/)
    const b3 = batches.evaluateBatch({ batchId: 'B3', files: FILES, metaNames: ledgerWith(B1), batches: gatesCleared() })
    expect(b3.ok).toBe(false)
    expect(b3.reasons.join('\n')).toMatch(new RegExp(`outside batch B3 .*${M1.replace(/\./g, '\\.')}`))
  })

  test('non-contiguous range (unstamped migration inside the batch range) is refused', () => {
    // An unrecorded non-E2 migration that sorts inside B1 = unstamped ledger.
    const intruder = FILES.find((f) => f > B1[0] && f < B1[1] && !ALL_E2.includes(f))
    expect(intruder).toBeDefined()
    const meta = ledgerWith().filter((f) => f !== intruder)
    const r = batches.evaluateBatch({ batchId: 'B1', files: FILES, metaNames: meta, batches: gatesCleared() })
    expect(r.ok).toBe(false)
    expect(r.reasons.join('\n')).toMatch(new RegExp(`outside batch B1 .*${intruder.replace(/\./g, '\\.')}`))
  })

  test('a batch member already recorded (manual stamping / partial run) is refused', () => {
    const meta = [...ledgerWith(), EXC01]
    const r = batches.evaluateBatch({ batchId: 'B1', files: FILES, metaNames: meta, batches: gatesCleared() })
    expect(r.ok).toBe(false)
    expect(r.reasons.join('\n')).toMatch(/already recorded in SequelizeMeta.*20261011000001/)
  })

  test('missing migration file is refused', () => {
    const files = FILES.filter((f) => f !== M2)
    const r = batches.evaluateBatch({ batchId: 'B2', files, metaNames: ledgerWith(B1), batches: gatesCleared() })
    expect(r.ok).toBe(false)
    expect(r.reasons.join('\n')).toMatch(/missing migration file.*20261013000002/)
  })

  test('reversed range is refused', () => {
    const r = batches.evaluateBatch({
      batchId: 'B2',
      files: FILES,
      metaNames: ledgerWith(B1),
      batches: withBatch('B2', { migrations: [M5, M2, M1] })
    })
    expect(r.ok).toBe(false)
    expect(r.reasons.join('\n')).toMatch(/strictly ascending/)
  })

  test('duplicate entries are refused', () => {
    const r = batches.evaluateBatch({
      batchId: 'B2',
      files: FILES,
      metaNames: ledgerWith(B1),
      batches: withBatch('B2', { migrations: [M1, M1, M5], expectedCount: 3 })
    })
    expect(r.ok).toBe(false)
    expect(r.reasons.join('\n')).toMatch(/strictly ascending/)
  })

  test('unexpected migration count is refused', () => {
    const r = batches.evaluateBatch({
      batchId: 'B2',
      files: FILES,
      metaNames: ledgerWith(B1),
      batches: withBatch('B2', { expectedCount: 4 })
    })
    expect(r.ok).toBe(false)
    expect(r.reasons.join('\n')).toMatch(/expected 4 migrations, contract lists 3/)
  })

  test('unknown batch id is refused', () => {
    const r = batches.evaluateBatch({ batchId: 'B9', files: FILES, metaNames: ledgerWith() })
    expect(r.ok).toBe(false)
    expect(r.reasons.join('\n')).toMatch(/unknown batch "B9"/)
  })

  test('B1 is governance-eligible now that DR-22 is resolved (real contract)', () => {
    const r = batches.evaluateBatch({ batchId: 'B1', files: FILES, metaNames: ledgerWith() })
    expect(r.ok).toBe(true)
    expect(r.reasons.join('\n')).not.toMatch(/open governance gate DR-22/)
    expect(r.migrations).toEqual(ORIGINAL_E2_13)
  })

  test('an unknown open gate still refuses (gate enforcement intact)', () => {
    const r = batches.evaluateBatch({
      batchId: 'B1',
      files: FILES,
      metaNames: ledgerWith(),
      batches: withBatch('B1', { openGates: [{ id: 'DR-22', reason: 'regression probe' }] })
    })
    expect(r.ok).toBe(false)
    expect(r.reasons.join('\n')).toMatch(/open governance gate DR-22/)
  })

  test('B3 evaluates clean now that P1 canonical writes are verified (real contract)', () => {
    const r = batches.evaluateBatch({ batchId: 'B3', files: FILES, metaNames: ledgerWith(B1, B2) })
    expect(r.reasons).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.migrations).toEqual([M3])
    expect(r.to).toBe(M3)
  })

  test('B2 has no code gate but still requires B1 recorded first (real contract)', () => {
    expect(batches.evaluateBatch({ batchId: 'B2', files: FILES, metaNames: ledgerWith(B1) }).ok).toBe(true)
    expect(batches.evaluateBatch({ batchId: 'B2', files: FILES, metaNames: ledgerWith() }).ok).toBe(false)
  })

  test('pendingBatchMembers lists every pending E2 member by batch', () => {
    const pending = batches.pendingBatchMembers({ files: FILES, metaNames: ledgerWith(B1) })
    expect(pending.map((p) => p.migration)).toEqual([M1, M2, M5, M3, ...B4])
    expect(pending.map((p) => p.batch)).toEqual(['B2', 'B2', 'B2', 'B3', 'B4'])
    expect(batches.pendingBatchMembers({ files: FILES, metaNames: ledgerWith(B1, B2, B3, B4) })).toEqual([])
  })

  test('post-run verification accepts exactly the batch and flags anything else', () => {
    const before = ledgerWith(B1)
    expect(batches.verifyBatchRecorded({ migrations: B2, before, after: [...before, ...B2] }).ok).toBe(true)
    const extra = batches.verifyBatchRecorded({ migrations: B2, before, after: [...before, ...B2, M3] })
    expect(extra.ok).toBe(false)
    expect(extra.unexpected).toEqual([M3])
    const partial = batches.verifyBatchRecorded({ migrations: B2, before, after: [...before, M1] })
    expect(partial.ok).toBe(false)
    expect(partial.missing).toEqual([M2, M5])
  })
})

describe('D-08-EXC-01 interaction', () => {
  test('#12 is unchanged and keeps its existing-column guard (no-op when the column exists)', async () => {
    const mig = require(path.join(MIGRATIONS_DIR, EXC01))
    const addColumn = jest.fn()
    const qi = {
      addColumn,
      sequelize: {
        query: jest.fn(async (sql) => {
          if (/to_regclass/.test(sql)) return [[{ exists: true }]]
          if (/information_schema\.columns/.test(sql)) {
            return [['id', 'userId', 'tenantId', 'role', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'reactivatedAt'].map((column_name) => ({ column_name }))]
          }
          throw new Error(`unexpected SQL: ${sql}`)
        })
      }
    }
    await mig.up(qi, require('sequelize'))
    expect(addColumn).not.toHaveBeenCalled()
  })

  test('the batch contract and runner never write SequelizeMeta themselves', () => {
    for (const f of ['scripts/migration-batches.js', 'scripts/run-migrations.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
      expect(src).not.toMatch(/INSERT\s+INTO\s+"?SequelizeMeta/i)
      expect(src).not.toMatch(/(UPDATE|DELETE\s+FROM)\s+"?SequelizeMeta/i)
      expect(src).not.toMatch(/bulkInsert\(\s*['"]SequelizeMeta/)
    }
  })
})

describe('D-08 batched runner (npm run migrate -- --batch)', () => {
  const okPreflight = (state) => ({
    resolveEnv: preflight.resolveEnv,
    report: () => {},
    runPreflight: jest.fn(async ({ env }) => ({ env, ok: true, applicable: true, reasons: [], ...state }))
  })
  let errSpy
  let logSpy
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    errSpy.mockRestore()
    logSpy.mockRestore()
  })

  test('--batch B2 spawns sequelize-cli bounded to M5 and verifies the ledger afterwards', async () => {
    const before = ledgerWith(B1)
    const spawn = jest.fn(() => ({ status: 0 }))
    const readMeta = jest.fn(async () => [...before, ...B2])
    const code = await runner.main({
      argv: ['--env', 'production', '--batch', 'B2'],
      preflight: okPreflight({ files: FILES, metaNames: before }),
      spawn,
      readMeta
    })
    expect(code).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('production', { to: M5 })
    expect(readMeta).toHaveBeenCalledWith('production')
  })

  test('post-run ledger mismatch fails the run (exit 1)', async () => {
    const before = ledgerWith(B1)
    const code = await runner.main({
      argv: ['--env=production', '--batch=B2'],
      preflight: okPreflight({ files: FILES, metaNames: before }),
      spawn: () => ({ status: 0 }),
      readMeta: async () => [...before, ...B2, M3]
    })
    expect(code).toBe(1)
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/POST-RUN LEDGER MISMATCH/)
  })

  test('runner failure status is propagated and the partial ledger is reported', async () => {
    const before = ledgerWith(B1)
    const code = await runner.main({
      argv: ['--env', 'production', '--batch', 'B2'],
      preflight: okPreflight({ files: FILES, metaNames: before }),
      spawn: () => ({ status: 7 }),
      readMeta: async () => [...before, M1]
    })
    expect(code).toBe(7)
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/recorded before failure.*20261013000001/)
  })

  test('preflight refusal still blocks a batched run (D-08 preflight stays authoritative)', async () => {
    const spawn = jest.fn()
    const pf = {
      resolveEnv: preflight.resolveEnv,
      report: () => {},
      runPreflight: jest.fn(async ({ env }) => ({ env, ok: false, applicable: true, reasons: ['dispositions not stamped'] }))
    }
    const code = await runner.main({ argv: ['--env', 'production', '--batch', 'B2'], preflight: pf, spawn, readMeta: jest.fn() })
    expect(code).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('B3 proceeds past gate evaluation now that the gate is cleared (B1 gate resolved)', async () => {
    // B3 runs through its execution guards (run lock, session probe, M3
    // state checks); all are injected so no database is touched.
    const guard = batches.BATCH_SESSION_GUARDS.B3
    const m3Row = {
      schema: 'public',
      table: 'transaction',
      contype: 'c',
      convalidated: false,
      columns: ['typePayment'],
      def:
        'CHECK ((("typePayment")::text = ANY ((ARRAY[' +
        batches.M3_CONSTRAINT.values.map((v) => `'${v}'::character varying`).join(', ') +
        '])::text[]))) NOT VALID'
    }
    const column = { relation: 'public.transaction', relkind: 'r', matches: 1, notNull: true }
    const states = [{ constraints: [], ledgerCount: 0, column }, { constraints: [m3Row], ledgerCount: 1, column }]
    const spawn = jest.fn(() => ({ status: 0 }))
    const metas = [ledgerWith(B1, B2), [...ledgerWith(B1, B2), M3]]
    const readMeta = jest.fn(async () => metas.shift())
    const code = await runner.main({
      argv: ['--env', 'production', '--batch', 'B3'],
      preflight: okPreflight({ files: FILES, metaNames: ledgerWith(B1, B2) }),
      spawn,
      readMeta,
      acquireRunLock: async () => ({ acquired: true, stillHeld: async () => ({ held: true }), release: async () => {} }),
      probeSession: async () => ({ lockTimeoutMs: guard.lockTimeoutMs, statementTimeoutMs: guard.statementTimeoutMs, applicationName: guard.applicationName }),
      readBatchState: async () => states.shift()
    })
    expect(code).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('production', { to: M3, childEnv: batches.sessionEnv(guard) })
    expect(readMeta).toHaveBeenCalledWith('production')
  })

  test('B2 refused while B1 is pending (cannot run past a batch boundary)', async () => {
    const spawn = jest.fn()
    const code = await runner.main({
      argv: ['--env', 'production', '--batch', 'B2'],
      preflight: okPreflight({ files: FILES, metaNames: ledgerWith() }),
      spawn,
      readMeta: jest.fn()
    })
    expect(code).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('unbatched run in a governed environment is refused while any batch member is pending', async () => {
    const spawn = jest.fn()
    const code = await runner.main({
      argv: ['--env', 'production'],
      preflight: okPreflight({ files: FILES, metaNames: ledgerWith(B1) }),
      spawn
    })
    expect(code).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/requires --batch.*B2.*B3/)
  })

  test('unbatched run in a governed environment fails closed when ledger state is not supplied', async () => {
    const spawn = jest.fn()
    const code = await runner.main({ argv: ['--env', 'production'], preflight: okPreflight({}), spawn })
    expect(code).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('--batch is refused for a non-governed (local) environment', async () => {
    const spawn = jest.fn()
    const pf = {
      resolveEnv: preflight.resolveEnv,
      report: () => {},
      runPreflight: jest.fn(async ({ env }) => ({ env, ok: true, applicable: false, reasons: [], files: FILES }))
    }
    const code = await runner.main({ argv: ['--env', 'development', '--batch', 'B2'], preflight: pf, spawn, readMeta: jest.fn() })
    expect(code).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('malformed or unknown --batch is refused before preflight; raw --to stays refused', async () => {
    for (const argv of [['--batch'], ['--batch', 'B9'], ['--batch=b2'], ['--batch', 'B1', '--batch', 'B2'], ['--to', M5], ['--batch', 'B2', '--to', M3]]) {
      const spawn = jest.fn()
      const pf = okPreflight({ files: FILES, metaNames: ledgerWith(B1) })
      const code = await runner.main({ argv, preflight: pf, spawn, readMeta: jest.fn() })
      expect(code).toBe(1)
      expect(pf.runPreflight).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    }
  })
})
