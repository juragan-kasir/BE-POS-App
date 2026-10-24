process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// D-08 B3 execution guards — pure. The runner is exercised with an injected
// preflight, spawn, ledger reader, run lock, session probe and state reader.
// No database is touched and sequelize-cli is never started here; the real
// PostgreSQL behavior is covered by migration-b3-lock-timeout.test.js on a
// disposable database.
const batches = require('../scripts/migration-batches')
const runner = require('../scripts/run-migrations')
const preflight = require('../scripts/check-migration-preflight')
const sessionGuard = require('../scripts/migration-session-guard')
const { discoverMigrationFiles } = require('../scripts/check-production-schema')
const m3Migration = require('../db/migrations/20261013000005-p1-canonical-payment-check')
const { CANONICAL_PAYMENT_METHODS } = require('../api/service/canonicalPayment')
const config = require('../config/config')

const FILES = discoverMigrationFiles()
const M3 = batches.M3_MIGRATION
const M5 = '20261013000004-p1-register-close-snapshot.js'
const B1 = batches.E2_BATCHES.B1.migrations
const B2 = batches.E2_BATCHES.B2.migrations
const ALL_E2 = [...B1, ...B2, ...batches.E2_BATCHES.B3.migrations, ...batches.E2_BATCHES.B4.migrations]
const ledgerWith = (...ran) => FILES.filter((f) => !ALL_E2.includes(f) || ran.flat().includes(f))
const POST_INCIDENT_MIGRATIONS = [
  '20261023000001-harden-audit-log.js',
  '20261024000001-dr28-widen-text-columns.js'
]
const incidentLedgerWith = (...ran) =>
  ledgerWith(...ran).filter((f) => !POST_INCIDENT_MIGRATIONS.includes(f))
const BEFORE_B3 = ledgerWith(B1, B2)
const AFTER_B3 = [...BEFORE_B3, M3]
const GUARD = batches.BATCH_SESSION_GUARDS.B3
const GUARD_ENV = { PGOPTIONS: '-c lock_timeout=3000 -c statement_timeout=60000', PGAPPNAME: 'd08-b3-m3' }

// Exactly what PostgreSQL 17.11 renders for M3 (captured on a disposable
// cluster; same shape on 14.19).
const defFor = (values, { notValid = true } = {}) =>
  'CHECK ((("typePayment")::text = ANY ((ARRAY[' +
  values.map((v) => `'${v}'::character varying`).join(', ') +
  `])::text[])))${notValid ? ' NOT VALID' : ''}`
const goodRow = (patch = {}) => ({
  schema: 'public',
  table: 'transaction',
  contype: 'c',
  convalidated: false,
  columns: ['typePayment'],
  def: defFor(batches.M3_CONSTRAINT.values),
  ...patch
})
// public.transaction("typePayment") as the catalog reports a NOT NULL column.
const COLUMN_OK = Object.freeze({ relation: 'public.transaction', relkind: 'r', matches: 1, notNull: true })
const ABSENT = { constraints: [], ledgerCount: 0, column: COLUMN_OK }
const PRESENT = { constraints: [goodRow()], ledgerCount: 1, column: COLUMN_OK }
const observedOk = { lockTimeoutMs: 3000, statementTimeoutMs: 60000, applicationName: 'd08-b3-m3' }

const okPreflight = (metaNames) => ({
  resolveEnv: preflight.resolveEnv,
  report: () => {},
  runPreflight: jest.fn(async ({ env }) => ({ env, ok: true, applicable: true, reasons: [], files: FILES, metaNames }))
})

// A B3 scenario: every dependency injected; `metas` / `states` are consumed
// in call order (pre-run read under the lock, then post-run read).
function scenario({
  metas = [BEFORE_B3, AFTER_B3],
  states = [ABSENT, PRESENT],
  status = 0,
  lock,
  probe = async () => observedOk,
  batch = 'B3'
} = {}) {
  const release = jest.fn(async () => {})
  const deps = {
    argv: ['--env', 'production', '--batch', batch],
    preflight: okPreflight(batch === 'B3' ? BEFORE_B3 : ledgerWith(B1)),
    spawn: jest.fn(() => ({ status })),
    readMeta: jest.fn(async () => {
      const next = metas.shift()
      if (next instanceof Error) throw next
      return next
    }),
    acquireRunLock: jest.fn(lock || (async () => ({ acquired: true, stillHeld: async () => ({ held: true }), release }))),
    probeSession: jest.fn(probe),
    readBatchState: jest.fn(async () => {
      const next = states.shift()
      if (next instanceof Error) throw next
      return next
    })
  }
  return { deps, release }
}

describe('D-08 B3 guard contract', () => {
  let logSpy
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => logSpy.mockRestore())

  test('only B3 carries a session guard and state checks (B1/B2 and the resume are unguarded)', () => {
    expect(Object.keys(batches.BATCH_SESSION_GUARDS)).toEqual(['B3'])
    expect(Object.keys(batches.BATCH_STATE_CHECKS)).toEqual(['B3'])
    expect(GUARD).toEqual({ lockTimeoutMs: 3000, statementTimeoutMs: 60000, applicationName: 'd08-b3-m3' })
    expect(Object.isFrozen(batches.BATCH_SESSION_GUARDS.B3)).toBe(true)
    expect(batches.sessionEnv(GUARD)).toEqual(GUARD_ENV)
  })

  test('the expected M3 constraint is an independent literal that agrees with the migration and the app boundary', () => {
    expect(batches.E2_BATCHES.B3.migrations).toEqual([batches.M3_MIGRATION])
    expect(batches.M3_CONSTRAINT.name).toBe(m3Migration.CONSTRAINT_NAME)
    expect([...batches.M3_CONSTRAINT.values]).toEqual([...m3Migration.CANONICAL_METHODS])
    expect([...batches.M3_CONSTRAINT.values]).toEqual([...CANONICAL_PAYMENT_METHODS])
  })

  test('connection configs never shadow the PGOPTIONS / PGAPPNAME environment fallback', () => {
    for (const env of ['production', 'staging']) {
      const dialectOptions = config[env].dialectOptions || {}
      for (const key of ['options', 'application_name', 'lock_timeout', 'statement_timeout']) {
        expect(dialectOptions).not.toHaveProperty(key)
      }
    }
  })
})

describe('B3 session settings verification', () => {
  test('exact values pass', () => {
    expect(batches.verifySessionSettings(observedOk, GUARD)).toEqual({ ok: true, failures: [] })
  })

  test('a pooler that silently dropped the startup options (server defaults) fails', () => {
    const r = batches.verifySessionSettings({ lockTimeoutMs: 0, statementTimeoutMs: 0, applicationName: '' }, GUARD)
    expect(r.ok).toBe(false)
    expect(r.failures).toHaveLength(3)
  })

  test('any single deviation fails; missing observation fails closed', () => {
    expect(batches.verifySessionSettings({ ...observedOk, lockTimeoutMs: 30000 }, GUARD).ok).toBe(false)
    expect(batches.verifySessionSettings({ ...observedOk, statementTimeoutMs: null }, GUARD).ok).toBe(false)
    expect(batches.verifySessionSettings({ ...observedOk, applicationName: 'other' }, GUARD).ok).toBe(false)
    expect(batches.verifySessionSettings(null, GUARD).ok).toBe(false)
  })

  test('probeSessionSettings parses the child result line and fails closed otherwise', () => {
    const line = `${sessionGuard.PROBE_MARKER}${JSON.stringify(observedOk)}`
    const ok = jest.fn(() => ({ status: 0, stdout: `noise\n${line}\n`, stderr: '' }))
    expect(sessionGuard.probeSessionSettings('production', GUARD_ENV, { spawn: ok, preflight })).toEqual(observedOk)
    const [, args, opts] = ok.mock.calls[0]
    expect(args.slice(-2)).toEqual(['--env', 'production'])
    expect(opts.env).toMatchObject({ ...GUARD_ENV, NODE_ENV: 'production' })
    expect(() =>
      sessionGuard.probeSessionSettings('production', GUARD_ENV, { spawn: () => ({ status: 1, stdout: '', stderr: 'unsupported startup parameter: options' }), preflight })
    ).toThrow(/exited 1.*unsupported startup parameter/)
    expect(() => sessionGuard.probeSessionSettings('production', GUARD_ENV, { spawn: () => ({ status: 0, stdout: 'nothing', stderr: '' }), preflight })).toThrow(
      /no result line/
    )
  })
})

describe('M3 postcondition verification (catalog state)', () => {
  test('a correct NOT VALID constraint recorded once passes', () => {
    expect(batches.verifyM3CanonicalCheck(PRESENT)).toEqual({ ok: true, failures: [] })
  })

  test('canonical values in another order still pass (IN-list order is not semantic)', () => {
    const shuffled = [...batches.M3_CONSTRAINT.values].reverse()
    expect(batches.verifyM3CanonicalCheck({ constraints: [goodRow({ def: defFor(shuffled) })], ledgerCount: 1, column: COLUMN_OK }).ok).toBe(true)
  })

  const failing = {
    'validated constraint (convalidated = true)': { constraints: [goodRow({ convalidated: true })], ledgerCount: 1, column: COLUMN_OK },
    'definition without NOT VALID': { constraints: [goodRow({ def: defFor(batches.M3_CONSTRAINT.values, { notValid: false }) })], ledgerCount: 1, column: COLUMN_OK },
    'extra non-canonical value': { constraints: [goodRow({ def: defFor([...batches.M3_CONSTRAINT.values, 'cash']) })], ledgerCount: 1, column: COLUMN_OK },
    'missing canonical value': { constraints: [goodRow({ def: defFor(batches.M3_CONSTRAINT.values.slice(0, 6)) })], ledgerCount: 1, column: COLUMN_OK },
    'duplicated value': { constraints: [goodRow({ def: defFor([...batches.M3_CONSTRAINT.values, 'CASH']) })], ledgerCount: 1, column: COLUMN_OK },
    'NOT IN (<> ALL) shape': {
      constraints: [goodRow({ def: goodRow().def.replace('= ANY', '<> ALL') })],
      ledgerCount: 1, column: COLUMN_OK
    },
    'extra OR clause': {
      constraints: [goodRow({ def: goodRow().def.replace('CHECK ((', 'CHECK ((true OR ') })],
      ledgerCount: 1, column: COLUMN_OK
    },
    'wrong table': { constraints: [goodRow({ table: 'checkout' })], ledgerCount: 1, column: COLUMN_OK },
    'wrong schema': { constraints: [goodRow({ schema: 'audit' })], ledgerCount: 1, column: COLUMN_OK },
    'wrong column': { constraints: [goodRow({ columns: ['notes'] })], ledgerCount: 1, column: COLUMN_OK },
    'not a CHECK': { constraints: [goodRow({ contype: 'u' })], ledgerCount: 1, column: COLUMN_OK },
    'two same-named constraints': { constraints: [goodRow(), goodRow({ table: 'checkout' })], ledgerCount: 1, column: COLUMN_OK },
    'constraint absent': { constraints: [], ledgerCount: 1, column: COLUMN_OK },
    'M3 not recorded': { constraints: [goodRow()], ledgerCount: 0, column: COLUMN_OK },
    'M3 recorded twice': { constraints: [goodRow()], ledgerCount: 2, column: COLUMN_OK },
    'state unavailable': null
  }
  for (const [name, state] of Object.entries(failing)) {
    test(`fails: ${name}`, () => {
      const r = batches.verifyM3CanonicalCheck(state)
      expect(r.ok).toBe(false)
      expect(r.failures.length).toBeGreaterThan(0)
    })
  }

  test('pre-run check requires the constraint absent everywhere and M3 unrecorded', () => {
    expect(batches.verifyM3Absent(ABSENT)).toEqual({ ok: true, failures: [] })
    expect(batches.verifyM3Absent({ constraints: [goodRow()], ledgerCount: 0, column: COLUMN_OK }).failures[0]).toMatch(/already exists.*never adopts/)
    expect(batches.verifyM3Absent({ constraints: [], ledgerCount: 1, column: COLUMN_OK }).ok).toBe(false)
    expect(batches.verifyM3Absent(undefined).ok).toBe(false)
  })
})

describe('D-08 B3 guarded runner (injected, no database)', () => {
  let errSpy
  let logSpy
  const out = () => [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
  const batchRecord = () => {
    const line = logSpy.mock.calls.flat().find((l) => typeof l === 'string' && l.startsWith('[migrate] BATCH RECORD '))
    return line ? JSON.parse(line.slice('[migrate] BATCH RECORD '.length)) : null
  }
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    errSpy.mockRestore()
    logSpy.mockRestore()
  })

  test('B3 success: lock → ledger re-check → pre-state → probe → guarded spawn → ledger + postconditions → RECORDED', async () => {
    const { deps, release } = scenario()
    const code = await runner.main(deps)
    expect(code).toBe(0)
    expect(deps.spawn).toHaveBeenCalledTimes(1)
    expect(deps.spawn).toHaveBeenCalledWith('production', { to: M3, childEnv: GUARD_ENV })
    expect(deps.probeSession).toHaveBeenCalledWith('production', GUARD_ENV)
    expect(deps.readBatchState).toHaveBeenCalledWith('production', 'M3_CANONICAL_CHECK')
    expect(release).toHaveBeenCalledTimes(1)
    const rec = batchRecord()
    expect(rec).toMatchObject({ batch: 'B3', outcome: 'RECORDED', exitCode: 0, runnerStatus: 0, runLock: 'RELEASED', ledgerBefore: BEFORE_B3.length })
    expect(rec.added).toEqual([M3])
    expect(rec.postconditions).toMatchObject({ id: 'M3_CANONICAL_CHECK', ok: true })
    expect(rec.sessionObserved).toEqual(observedOk)
    expect(JSON.stringify(rec)).not.toMatch(/password|POSTGRES_|postgres:\/\//i)
  })

  test('non-B3 batches keep the unguarded path: exact { to } spawn, no lock/probe/state reads', async () => {
    const before = ledgerWith(B1)
    const { deps } = scenario({ batch: 'B2', metas: [[...before, ...B2]] })
    const code = await runner.main(deps)
    expect(code).toBe(0)
    expect(deps.spawn).toHaveBeenCalledWith('production', { to: M5 })
    expect(deps.acquireRunLock).not.toHaveBeenCalled()
    expect(deps.probeSession).not.toHaveBeenCalled()
    expect(deps.readBatchState).not.toHaveBeenCalled()
    expect(batchRecord()).toBeNull()
  })

  test('lock-timeout failure (runner exit 1, ledger and schema unchanged) is RUNNER_FAILED, never success', async () => {
    const { deps, release } = scenario({ status: 1, metas: [BEFORE_B3, BEFORE_B3], states: [ABSENT, ABSENT] })
    const code = await runner.main(deps)
    expect(code).toBe(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(batchRecord()).toMatchObject({ outcome: 'RUNNER_FAILED', exitCode: 1, runnerStatus: 1, added: [] })
    expect(out()).not.toMatch(/recorded exactly/)
    expect(out()).toMatch(/never retries/)
  })

  test('ledger re-read failure after the run is LEDGER_UNVERIFIED and exits non-zero (even when the runner exited 0)', async () => {
    const { deps } = scenario({ metas: [BEFORE_B3, new Error('connection reset')] })
    const code = await runner.main(deps)
    expect(code).toBe(1)
    expect(batchRecord()).toMatchObject({ outcome: 'LEDGER_UNVERIFIED', exitCode: 1 })
    expect(out()).toMatch(/LEDGER_UNVERIFIED for batch B3.*connection reset/)
  })

  test('unguarded batches also report LEDGER_UNVERIFIED instead of an unhandled rejection', async () => {
    const { deps } = scenario({ batch: 'B2', metas: [new Error('socket hang up')] })
    const code = await runner.main(deps)
    expect(code).toBe(1)
    expect(out()).toMatch(/LEDGER_UNVERIFIED for batch B2.*socket hang up/)
  })

  test('DDL committed but ledger write failed (runner exit 1, constraint present, M3 unrecorded) is PARTIAL_STATE', async () => {
    const { deps } = scenario({ status: 1, metas: [BEFORE_B3, BEFORE_B3], states: [ABSENT, { constraints: [goodRow()], ledgerCount: 0, column: COLUMN_OK }] })
    const code = await runner.main(deps)
    expect(code).toBe(1)
    expect(batchRecord()).toMatchObject({ outcome: 'PARTIAL_STATE', exitCode: 1 })
    expect(out()).toMatch(/Do NOT rerun/)
    expect(out()).not.toMatch(/recorded exactly/)
  })

  test('runner exit 0 with constraint present but M3 unrecorded is LEDGER_MISMATCH, never complete', async () => {
    const { deps } = scenario({ metas: [BEFORE_B3, BEFORE_B3], states: [ABSENT, { constraints: [goodRow()], ledgerCount: 0, column: COLUMN_OK }] })
    const code = await runner.main(deps)
    expect(code).toBe(1)
    expect(batchRecord()).toMatchObject({ outcome: 'LEDGER_MISMATCH' })
  })

  test('post-run state unreadable is STATE_UNVERIFIED (exit non-zero) even though the ledger looks right', async () => {
    const { deps } = scenario({ states: [ABSENT, new Error('read timeout')] })
    const code = await runner.main(deps)
    expect(code).toBe(1)
    expect(batchRecord()).toMatchObject({ outcome: 'STATE_UNVERIFIED' })
  })

  test('a validated or wrong constraint after the run is POSTCONDITION_FAILED; nothing is dropped or unrecorded', async () => {
    for (const bad of [goodRow({ convalidated: true }), goodRow({ def: defFor([...batches.M3_CONSTRAINT.values, 'cash']) })]) {
      const { deps } = scenario({ states: [ABSENT, { constraints: [bad], ledgerCount: 1, column: COLUMN_OK }] })
      const code = await runner.main(deps)
      expect(code).toBe(1)
      expect(batchRecord()).toMatchObject({ outcome: 'POSTCONDITION_FAILED', exitCode: 1 })
      expect(deps.spawn).toHaveBeenCalledTimes(1)
      logSpy.mockClear()
    }
  })

  test('concurrency: run lock held by another run → REFUSED before spawn', async () => {
    const { deps } = scenario({ lock: async () => ({ acquired: false }) })
    const code = await runner.main(deps)
    expect(code).toBe(1)
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(deps.probeSession).not.toHaveBeenCalled()
    expect(batchRecord()).toMatchObject({ outcome: 'REFUSED', runLock: 'HELD_BY_ANOTHER_RUN' })
  })

  test('run lock unavailable (error) → REFUSED before spawn (fail closed)', async () => {
    const { deps } = scenario({
      lock: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    expect(await runner.main(deps)).toBe(1)
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(batchRecord().runLock).toMatch(/UNAVAILABLE: ECONNREFUSED/)
  })

  test('ledger moved between preflight and lock (a concurrent run finished first) → REFUSED, lock released', async () => {
    const { deps, release } = scenario({ metas: [AFTER_B3] })
    expect(await runner.main(deps)).toBe(1)
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    expect(out()).toMatch(/SequelizeMeta changed since the preflight/)
  })

  test('pre-existing same-named constraint → REFUSED (never adopted by IF NOT EXISTS)', async () => {
    const { deps } = scenario({ states: [{ constraints: [goodRow()], ledgerCount: 0, column: COLUMN_OK }] })
    expect(await runner.main(deps)).toBe(1)
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(deps.probeSession).not.toHaveBeenCalled()
    expect(batchRecord()).toMatchObject({ outcome: 'REFUSED', preconditions: { ok: false } })
  })

  test('endpoint did not apply the session guard (probe shows defaults) → REFUSED before spawn', async () => {
    const { deps } = scenario({ probe: async () => ({ lockTimeoutMs: 0, statementTimeoutMs: 0, applicationName: '' }) })
    expect(await runner.main(deps)).toBe(1)
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(out()).toMatch(/did not apply the session guard/)
  })

  test('session probe failure (e.g. pooler rejects startup options) → REFUSED before spawn', async () => {
    const { deps } = scenario({
      probe: async () => {
        throw new Error('unsupported startup parameter: options')
      }
    })
    expect(await runner.main(deps)).toBe(1)
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(out()).toMatch(/session guard unproven.*unsupported startup parameter/)
  })

  test('lock release failure is reported in the record and does not hide the outcome', async () => {
    const { deps } = scenario({
      lock: async () => ({
        acquired: true,
        stillHeld: async () => ({ held: true }),
        release: async () => {
          throw new Error('terminating connection')
        }
      })
    })
    expect(await runner.main(deps)).toBe(0)
    expect(batchRecord()).toMatchObject({ outcome: 'RECORDED', runLock: 'RELEASE_FAILED: terminating connection' })
    expect(out()).toMatch(/run lock release failed/)
  })

  test('an unexpected error inside the guarded run is UNEXPECTED_ERROR (exit 1), never success; the lock is still released', async () => {
    const { deps, release } = scenario()
    deps.spawn = jest.fn(() => {
      throw new Error('spawn EAGAIN')
    })
    expect(await runner.main(deps)).toBe(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(batchRecord()).toMatchObject({ outcome: 'UNEXPECTED_ERROR', exitCode: 1, runLock: 'RELEASED' })
    expect(out()).toMatch(/spawn EAGAIN.*state unknown/)
  })

  test('--resume B1-D05 runs its own path: exact { to } spawn, never the B3 guards', async () => {
    const D05 = '20261012000001-d05-member-identity-uniqueness.js'
    const incident = incidentLedgerWith(B1.slice(0, 12))
    const deps = {
      argv: ['--env', 'production', '--resume', 'B1-D05'],
      preflight: okPreflight(incident),
      spawn: jest.fn(() => ({ status: 0 })),
      readMeta: jest.fn(async () => [...incident, D05]),
      readPostconditionState: jest.fn(async () => ({ indexDefs: {}, constraintNames: [], nonCanonicalActivePhones: 0 })),
      acquireRunLock: jest.fn(),
      probeSession: jest.fn(),
      readBatchState: jest.fn()
    }
    await runner.main(deps)
    expect(deps.spawn).toHaveBeenCalledWith('production', { to: D05 })
    expect(deps.readPostconditionState).toHaveBeenCalled()
    expect(deps.acquireRunLock).not.toHaveBeenCalled()
    expect(deps.probeSession).not.toHaveBeenCalled()
    expect(deps.readBatchState).not.toHaveBeenCalled()
  })
})

describe('defaultSpawn environment layering', () => {
  // Captures the real defaultSpawn's spawnSync call without starting anything.
  const captureSpawns = (calls) => {
    const captured = []
    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({
        spawnSync: (cmd, args, opts) => {
          captured.push({ cmd, args, opts })
          return { status: 0 }
        }
      }))
      const isolated = require('../scripts/run-migrations')
      for (const [env, opts] of calls) isolated.defaultSpawn(env, opts)
    })
    jest.dontMock('child_process')
    return captured
  }

  test('the B3 child gets the guard env; NODE_ENV cannot be overridden; unguarded spawns get no guard env', () => {
    const saved = { PGOPTIONS: process.env.PGOPTIONS, PGAPPNAME: process.env.PGAPPNAME }
    delete process.env.PGOPTIONS
    delete process.env.PGAPPNAME
    try {
      const [guarded, plain] = captureSpawns([
        ['production', { to: M3, childEnv: { ...GUARD_ENV, NODE_ENV: 'development' } }],
        ['production', { to: M5 }]
      ])
      expect(guarded.args.slice(-5)).toEqual(['db:migrate', '--env', 'production', '--to', M3])
      expect(guarded.opts.env).toMatchObject({ ...GUARD_ENV, NODE_ENV: 'production' })
      expect(plain.args.slice(-2)).toEqual(['--to', M5])
      expect(plain.opts.env.PGOPTIONS).toBeUndefined()
      expect(plain.opts.env.PGAPPNAME).toBeUndefined()
      // The runner process itself never carries the guard env.
      expect(process.env.PGOPTIONS).toBeUndefined()
      expect(process.env.PGAPPNAME).toBeUndefined()
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
    }
  })
})

describe('R1 — run-lock loss is never success', () => {
  let errSpy
  let logSpy
  const out = () => [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
  const batchRecord = () => {
    const line = logSpy.mock.calls.flat().find((l) => typeof l === 'string' && l.startsWith('[migrate] BATCH RECORD '))
    return line ? JSON.parse(line.slice('[migrate] BATCH RECORD '.length)) : null
  }
  const successLine = () => logSpy.mock.calls.flat().some((l) => typeof l === 'string' && l.startsWith('[migrate] batch B3 recorded exactly'))
  // stillHeld answers in call order: before-spawn, after-child, after-verification.
  const lockAnswering = (...answers) => {
    const release = jest.fn(async () => {})
    const stillHeld = jest.fn(async () => {
      const a = answers.shift()
      if (a instanceof Error) throw a
      return a
    })
    return { lock: async () => ({ acquired: true, stillHeld, release }), stillHeld, release }
  }
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    errSpy.mockRestore()
    logSpy.mockRestore()
  })

  test('the namespaced key is two distinct int32 halves, distinct from CAP-003', () => {
    const cap = require('../scripts/controlled-apply-production').advisoryLockKeys()
    expect(batches.D08_RUNNER_LOCK_KEYS).toHaveLength(2)
    for (const k of batches.D08_RUNNER_LOCK_KEYS) expect(Number.isInteger(k) && k >= -(2 ** 31) && k < 2 ** 31).toBe(true)
    expect([...batches.D08_RUNNER_LOCK_KEYS]).not.toEqual([...cap])
    expect(Object.isFrozen(batches.D08_RUNNER_LOCK_KEYS)).toBe(true)
  })

  test('lock lost before spawn → REFUSED, child never spawned, lock still released', async () => {
    const l = lockAnswering({ held: false, reason: 'holder session unusable: terminating connection' })
    const { deps } = scenario({ lock: l.lock })
    expect(await runner.main(deps)).toBe(1)
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(l.release).toHaveBeenCalledTimes(1)
    const rec = batchRecord()
    expect(rec).toMatchObject({ outcome: 'REFUSED', runLockChecks: [{ at: 'before-spawn', held: false }] })
    expect(rec.message).toMatch(/run lock lost before the migration started/)
  })

  test('lock lost while the child ran → SERIALIZATION_LOST (exit 1) even with child exit 0, ledger row and a valid constraint', async () => {
    const l = lockAnswering({ held: true }, { held: false, reason: 'advisory lock not held by the holder session (count 0)' }, { held: false })
    const { deps } = scenario({ lock: l.lock })
    expect(await runner.main(deps)).toBe(1)
    expect(deps.spawn).toHaveBeenCalledTimes(1)
    const rec = batchRecord()
    expect(rec).toMatchObject({ outcome: 'SERIALIZATION_LOST', exitCode: 1, runnerStatus: 0, observedOutcome: 'RECORDED', added: [M3] })
    expect(rec.runLockChecks.map((c) => [c.at, c.held])).toEqual([
      ['before-spawn', true],
      ['after-child', false],
      ['after-verification', false]
    ])
    expect(rec.postconditions).toMatchObject({ ok: true })
    expect(rec.message).toMatch(/not provably held.*after-child.*Observed, not proven exclusive/)
    expect(successLine()).toBe(false)
  })

  test('lock lost during post-run verification → SERIALIZATION_LOST', async () => {
    const l = lockAnswering({ held: true }, { held: true }, { held: false, reason: 'holder session unusable: Connection terminated' })
    const { deps } = scenario({ lock: l.lock })
    expect(await runner.main(deps)).toBe(1)
    expect(batchRecord()).toMatchObject({ outcome: 'SERIALIZATION_LOST', observedOutcome: 'RECORDED' })
    expect(successLine()).toBe(false)
  })

  test('a throwing stillHeld() counts as lost; a failing child keeps its own exit code', async () => {
    const l = lockAnswering({ held: true }, new Error('socket closed'), { held: true })
    const { deps } = scenario({ lock: l.lock, status: 3, metas: [BEFORE_B3, BEFORE_B3], states: [ABSENT, ABSENT] })
    expect(await runner.main(deps)).toBe(3)
    const rec = batchRecord()
    expect(rec).toMatchObject({ outcome: 'SERIALIZATION_LOST', exitCode: 3, observedOutcome: 'RUNNER_FAILED' })
    expect(rec.runLockChecks[1]).toMatchObject({ at: 'after-child', held: false, reason: 'socket closed' })
  })

  test('a lock without stillHeld() is never trusted → REFUSED before spawn', async () => {
    const { deps } = scenario({ lock: async () => ({ acquired: true, release: async () => {} }) })
    expect(await runner.main(deps)).toBe(1)
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(out()).toMatch(/exposes no stillHeld/)
  })

  test('success keeps the lock across child and verification (three held checks) and releases it once', async () => {
    const l = lockAnswering({ held: true }, { held: true }, { held: true })
    const { deps } = scenario({ lock: l.lock })
    expect(await runner.main(deps)).toBe(0)
    expect(l.stillHeld).toHaveBeenCalledTimes(3)
    expect(l.release).toHaveBeenCalledTimes(1)
    expect(batchRecord()).toMatchObject({ outcome: 'RECORDED', runLock: 'RELEASED', observedOutcome: null })
  })

  test('L2: a child killed by a signal is reported with the signal', async () => {
    const { deps } = scenario({ metas: [BEFORE_B3, BEFORE_B3], states: [ABSENT, ABSENT] })
    deps.spawn = jest.fn(() => ({ status: null, signal: 'SIGTERM' }))
    expect(await runner.main(deps)).toBe(1)
    const rec = batchRecord()
    expect(rec).toMatchObject({ outcome: 'RUNNER_FAILED', runnerSignal: 'SIGTERM' })
    expect(rec.message).toMatch(/signal SIGTERM/)
    expect(rec.message).toMatch(/constraint absent \(inspected; the rest of the schema was not inspected\)/)
  })

  test('L1: PARTIAL_STATE names what was actually observed', async () => {
    const { deps } = scenario({ status: 1, metas: [BEFORE_B3, BEFORE_B3], states: [ABSENT, PRESENT] })
    expect(await runner.main(deps)).toBe(1)
    expect(batchRecord().message).toMatch(/the DDL committed without its ledger row/)
    const second = scenario({ status: 1, metas: [BEFORE_B3, AFTER_B3], states: [ABSENT, PRESENT] })
    logSpy.mockClear()
    expect(await runner.main(second.deps)).toBe(1)
    expect(batchRecord().message).toMatch(/ledger and constraint both present although the runner reported failure/)
  })
})

describe('R2 — "typePayment" NOT NULL prerequisite', () => {
  const NULLABLE = { ...COLUMN_OK, notNull: false }
  const failingColumns = {
    nullable: NULLABLE,
    'attnotnull unknown': { ...COLUMN_OK, notNull: null },
    'relation missing': { relation: null, relkind: null, matches: 0, notNull: null },
    'relation is a view': { ...COLUMN_OK, relkind: 'v' },
    'column missing': { ...COLUMN_OK, matches: 0, notNull: null },
    'column ambiguous': { ...COLUMN_OK, matches: 2 },
    'state lacks column': undefined
  }
  for (const [name, column] of Object.entries(failingColumns)) {
    test(`pre and post checks fail closed: ${name}`, () => {
      expect(batches.verifyM3Absent({ constraints: [], ledgerCount: 0, column }).ok).toBe(false)
      expect(batches.verifyM3CanonicalCheck({ constraints: [goodRow()], ledgerCount: 1, column }).ok).toBe(false)
    })
  }

  test('nullable column before the run → REFUSED, never spawned', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { deps } = scenario({ states: [{ constraints: [], ledgerCount: 0, column: NULLABLE }] })
      expect(await runner.main(deps)).toBe(1)
      expect(deps.spawn).not.toHaveBeenCalled()
      expect(err.mock.calls.flat().join('\n')).toMatch(/is not NOT NULL.*M3 relies on it/)
    } finally {
      log.mockRestore()
      err.mockRestore()
    }
  })

  test('nullable column after the run → POSTCONDITION_FAILED even with the exact CHECK and the ledger row', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { deps } = scenario({ states: [ABSENT, { constraints: [goodRow()], ledgerCount: 1, column: NULLABLE }] })
      expect(await runner.main(deps)).toBe(1)
      const rec = JSON.parse(log.mock.calls.flat().find((l) => String(l).startsWith('[migrate] BATCH RECORD ')).slice(23))
      expect(rec.outcome).toBe('POSTCONDITION_FAILED')
    } finally {
      log.mockRestore()
      err.mockRestore()
    }
  })
})

describe('R3 — stubbed preflight can never reach a real database', () => {
  // Real runner/guard modules, with `sequelize` and `child_process` replaced
  // by counters: any attempt to construct a connection or start a process is
  // visible.
  const isolatedRunner = () => {
    const calls = { sequelize: 0, spawnSync: 0 }
    let isolated
    jest.isolateModules(() => {
      jest.doMock('sequelize', () => {
        const actual = jest.requireActual('sequelize')
        return {
          ...actual,
          Sequelize: function () {
            calls.sequelize++
            throw new Error('test: real connection attempted')
          }
        }
      })
      jest.doMock('child_process', () => ({
        ...jest.requireActual('child_process'),
        spawnSync: () => {
          calls.spawnSync++
          return { status: 0, stdout: '', stderr: '' }
        }
      }))
      isolated = {
        runner: require('../scripts/run-migrations'),
        guard: require('../scripts/migration-session-guard')
      }
    })
    jest.dontMock('sequelize')
    jest.dontMock('child_process')
    return { ...isolated, calls }
  }
  const stub = (metaNames) => ({
    resolveEnv: preflight.resolveEnv,
    report: () => {},
    runPreflight: async ({ env }) => ({ env, ok: true, applicable: true, reasons: [], files: FILES, metaNames })
  })
  let logSpy
  let errSpy
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
    errSpy.mockRestore()
  })

  test('B3 with a stub preflight and every guard/spawn injection omitted → REFUSED; no connection, no process', async () => {
    const { runner: r, calls } = isolatedRunner()
    const code = await r.main({ argv: ['--env', 'production', '--batch', 'B3'], preflight: stub(BEFORE_B3) })
    expect(code).toBe(1)
    expect(calls).toEqual({ sequelize: 0, spawnSync: 0 })
    const line = logSpy.mock.calls.flat().find((l) => String(l).startsWith('[migrate] BATCH RECORD '))
    expect(JSON.parse(line.slice(23))).toMatchObject({ outcome: 'REFUSED' })
    expect(line).toMatch(/guard dependency missing: preflight\.loadTargetConfig/)
  })

  test('B3 with a stub preflight but a live-looking lock injected still cannot probe or spawn', async () => {
    const { runner: r, calls } = isolatedRunner()
    const code = await r.main({
      argv: ['--env', 'production', '--batch', 'B3'],
      preflight: stub(BEFORE_B3),
      readMeta: async () => BEFORE_B3,
      readBatchState: async () => ABSENT,
      acquireRunLock: async () => ({ acquired: true, stillHeld: async () => ({ held: true }), release: async () => {} })
    })
    expect(code).toBe(1)
    expect(calls).toEqual({ sequelize: 0, spawnSync: 0 })
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/session guard unproven.*guard dependency missing/)
  })

  test('unguarded batch with a stub preflight and omitted spawn never starts sequelize-cli', async () => {
    const { runner: r, calls } = isolatedRunner()
    await expect(
      r.main({ argv: ['--env', 'production', '--batch', 'B2'], preflight: stub(ledgerWith(B1)), readMeta: async () => [] })
    ).rejects.toThrow(/guard dependency missing: preflight\.loadTargetConfig/)
    expect(calls).toEqual({ sequelize: 0, spawnSync: 0 })
  })

  test('guard functions refuse without an explicit connection-capable preflight', async () => {
    const { guard, calls } = isolatedRunner()
    await expect(guard.acquireRunLock('production')).rejects.toThrow(/guard dependency missing/)
    await expect(guard.acquireRunLock('production', { preflight: { resolveEnv: () => 'production' } })).rejects.toThrow(/guard dependency missing/)
    await expect(guard.readSessionSettings('production')).rejects.toThrow(/guard dependency missing/)
    expect(() => guard.probeSessionSettings('production', GUARD_ENV)).toThrow(/guard dependency missing/)
    expect(() => guard.probeSessionSettings('production', GUARD_ENV, { preflight: stub([]) })).toThrow(/guard dependency missing/)
    expect(calls).toEqual({ sequelize: 0, spawnSync: 0 })
  })
})
