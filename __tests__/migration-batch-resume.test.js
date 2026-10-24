process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// D-08 B1 resume (B1-D05) — the only sanctioned way to finish B1 after the
// 2026-10-08 incident run recorded B1 #1–#12 and D-05 aborted in its own
// preflight P1 (unparseable active phone values, count=4).
// Pure: evaluated from supplied repository files and a supplied SequelizeMeta
// name list; the runner is exercised with an injected preflight, spawn,
// ledger reader and postcondition reader. No database is touched and
// sequelize-cli is never started by these tests.
const fs = require('fs')
const path = require('path')

const batches = require('../scripts/migration-batches')
const runner = require('../scripts/run-migrations')
const preflight = require('../scripts/check-migration-preflight')
const { discoverMigrationFiles } = require('../scripts/check-production-schema')

const FILES = discoverMigrationFiles()
const D05 = '20261012000001-d05-member-identity-uniqueness.js'
const M1 = '20261013000001-p1-transaction-attribution.js'

const B1 = batches.E2_BATCHES.B1.migrations
const B2 = batches.E2_BATCHES.B2.migrations
const B3 = batches.E2_BATCHES.B3.migrations
const ALL_E2 = [...B1, ...B2, ...B3, ...batches.E2_BATCHES.B4.migrations]
const B1_FIRST_12 = B1.slice(0, 12)

// Migrations added after the 2026-10-08 incident are not part of the
// verified production ledger snapshot; keep the historical fixture frozen.
const POST_INCIDENT_MIGRATIONS = [
  '20261023000001-harden-audit-log.js',
  '20261024000001-dr28-widen-text-columns.js'
]

// Production-like ledger: every non-E2 file recorded, plus the given E2 names.
const ledgerWith = (...ran) =>
  FILES.filter(
    (f) =>
      !POST_INCIDENT_MIGRATIONS.includes(f) &&
      (!ALL_E2.includes(f) || ran.flat().includes(f))
  )
// The verified incident state: 223 stamped/legacy rows + B1 #1–#12 = 235.
const INCIDENT = ledgerWith(B1_FIRST_12)

const RESUME = batches.BATCH_RESUMES['B1-D05']
const gateCleared = (patch = {}) => ({ 'B1-D05': { ...RESUME, openGates: [], ...patch } })

// pg_indexes.indexdef / pg_constraint state exactly as PostgreSQL renders the
// four D-05 objects (see __tests__/d05-member-identity-migration.test.js).
const D05_DEFS = {
  member_pkey: 'CREATE UNIQUE INDEX member_pkey ON public.member USING btree (id)',
  uq_member_store_name_ci:
    'CREATE UNIQUE INDEX uq_member_store_name_ci ON public.member USING btree (store, lower(TRIM(BOTH FROM name))) WHERE ((store IS NOT NULL) AND ("deletedAt" IS NULL))',
  uq_member_global_name_ci:
    'CREATE UNIQUE INDEX uq_member_global_name_ci ON public.member USING btree (lower(TRIM(BOTH FROM name))) WHERE ((store IS NULL) AND ("deletedAt" IS NULL))',
  uq_member_phone_e164:
    'CREATE UNIQUE INDEX uq_member_phone_e164 ON public.member USING btree ("phoneNumber") WHERE (("deletedAt" IS NULL) AND (("phoneNumber")::text !~~ \'GUEST-%\'::text))',
  uq_member_email_ci:
    'CREATE UNIQUE INDEX uq_member_email_ci ON public.member USING btree (lower(TRIM(BOTH FROM email))) WHERE (("deletedAt" IS NULL) AND (email IS NOT NULL))'
}
const D05_STATE = { indexDefs: D05_DEFS, constraintNames: ['member_pkey'], nonCanonicalActivePhones: 0 }

describe('B1-D05 resume contract', () => {
  test('incident fixture is the verified production ledger shape (235 rows, B1 12/13)', () => {
    expect(INCIDENT).toHaveLength(235)
    expect(B1.filter((m) => INCIDENT.includes(m))).toEqual(B1_FIRST_12)
    expect(INCIDENT).not.toContain(D05)
  })

  test('is frozen, derived from B1, and does not alter the frozen B1 list', () => {
    expect(Object.isFrozen(batches.BATCH_RESUMES)).toBe(true)
    expect(Object.keys(batches.BATCH_RESUMES)).toEqual(['B1-D05'])
    expect(Object.isFrozen(RESUME)).toBe(true)
    expect(Object.isFrozen(RESUME.migrations)).toBe(true)
    expect(Object.isFrozen(RESUME.openGates)).toBe(true)
    expect(RESUME.batch).toBe('B1')
    expect(RESUME.migrations).toEqual([D05])
    expect(RESUME.recordedCount).toBe(12)
    expect(RESUME.ledgerBefore).toBe(235)
    expect(RESUME.ledgerAfter).toBe(236)
    expect(RESUME.postconditions).toBe('D05_MEMBER_IDENTITY')
    expect(B1).toHaveLength(13)
    expect(B1[12]).toBe(D05)
    expect(batches.validateResumeDefinition(RESUME)).toEqual([])
  })

  test('D-05 row-disposition gate is cleared on the real contract (formal gate review)', () => {
    expect(RESUME.openGates).toEqual([])
  })

  test('definition validation: resume members must be exactly the unrecorded suffix of the batch', () => {
    expect(batches.validateResumeDefinition({ ...RESUME, migrations: [B1[11]] })).toEqual(
      expect.arrayContaining([expect.stringMatching(/suffix/)])
    )
    expect(batches.validateResumeDefinition({ ...RESUME, recordedCount: 11 })).toEqual(
      expect.arrayContaining([expect.stringMatching(/recordedCount/)])
    )
    expect(batches.validateResumeDefinition({ ...RESUME, ledgerAfter: 237 })).toEqual(
      expect.arrayContaining([expect.stringMatching(/ledgerAfter/)])
    )
    expect(batches.validateResumeDefinition({ ...RESUME, batch: 'B9' })).toEqual(
      expect.arrayContaining([expect.stringMatching(/unknown base batch/)])
    )
    expect(batches.validateResumeDefinition({ ...RESUME, postconditions: 'NOPE' })).toEqual(
      expect.arrayContaining([expect.stringMatching(/postcondition/)])
    )
  })
})

describe('B1-D05 resume evaluation (fail closed)', () => {
  const evaluate = (metaNames, resumes = gateCleared(), files = FILES) =>
    batches.evaluateResume({ resumeId: 'B1-D05', files, metaNames, resumes })

  test('verified incident state + gate cleared: executes exactly D-05 (to = D-05)', () => {
    const e = evaluate(INCIDENT)
    expect(e.reasons).toEqual([])
    expect(e.ok).toBe(true)
    expect(e.migrations).toEqual([D05])
    expect(e.to).toBe(D05)
    expect(e.ledgerAfter).toBe(236)
  })

  test('real contract evaluates clean now that the D-05 row-disposition gate is cleared', () => {
    const e = batches.evaluateResume({ resumeId: 'B1-D05', files: FILES, metaNames: INCIDENT })
    expect(e.reasons).toEqual([])
    expect(e.ok).toBe(true)
    expect(e.migrations).toEqual([D05])
    expect(e.to).toBe(D05)
  })

  test('an unknown open gate still refuses the resume (fail-closed mechanism intact)', () => {
    const e = batches.evaluateResume({
      resumeId: 'B1-D05',
      files: FILES,
      metaNames: INCIDENT,
      resumes: gateCleared({ openGates: [{ id: 'SOME-FUTURE-GATE', reason: 'synthetic' }] })
    })
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(/open governance gate SOME-FUTURE-GATE/)
  })

  test('refused unless every one of the expected 12 B1 migrations is recorded', () => {
    const missingOne = INCIDENT.filter((n) => n !== B1[5])
    const e = evaluate(missingOne)
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(new RegExp(`not recorded.*${B1[5]}`))
  })

  test('refused when B1 never ran (0/13) — that is a full B1 run, not a resume', () => {
    const e = evaluate(ledgerWith())
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(/not recorded/)
  })

  test('refused when D-05 is already recorded (manual stamp / completed resume)', () => {
    const e = evaluate([...INCIDENT, D05])
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(/already recorded.*20261012000001/)
  })

  test('refused when the ledger row count differs from the incident state (235)', () => {
    const e = evaluate([...INCIDENT, '29990101000000-unexpected.js'])
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(/SequelizeMeta has 236 row\(s\); the B1-D05 resume requires exactly 235/)
  })

  test('refused when anything other than D-05 is pending before B2 (even at 235 rows)', () => {
    const stamped = FILES.find((f) => !ALL_E2.includes(f) && f < D05)
    const meta = [...INCIDENT.filter((n) => n !== stamped), M1]
    expect(meta).toHaveLength(235)
    const e = evaluate(meta)
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(new RegExp(`pending migration\\(s\\) outside B1-D05 would run first: ${stamped}`))
  })

  test('refused when a later batch member is already recorded', () => {
    const meta = [...INCIDENT.filter((n) => n !== B1[0]), M1]
    const e = evaluate(meta)
    expect(e.ok).toBe(false)
  })

  test('refused on duplicate SequelizeMeta names', () => {
    const e = evaluate([...INCIDENT.slice(0, 234), INCIDENT[0]])
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(/duplicate/)
  })

  test('refused when the D-05 migration file is missing', () => {
    const e = evaluate(INCIDENT, gateCleared(), FILES.filter((f) => f !== D05))
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(/missing migration file/)
  })

  test('refused when ledger state is unavailable', () => {
    const e = batches.evaluateResume({ resumeId: 'B1-D05', files: FILES, metaNames: undefined, resumes: gateCleared() })
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(/unavailable/)
  })

  test('unknown resume id is refused', () => {
    const e = batches.evaluateResume({ resumeId: 'B2-X', files: FILES, metaNames: INCIDENT })
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(/unknown resume/)
  })

  test('incident state still refuses --batch B1 and points at the reviewed resume contract', () => {
    const e = batches.evaluateBatch({ batchId: 'B1', files: FILES, metaNames: INCIDENT })
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(/already recorded/)
    expect(e.reasons.join('\n')).toMatch(/--resume B1-D05/)
  })

  test('incident state still refuses --batch B2 (D-05 pending would run first)', () => {
    const e = batches.evaluateBatch({ batchId: 'B2', files: FILES, metaNames: INCIDENT })
    expect(e.ok).toBe(false)
    expect(e.reasons.join('\n')).toMatch(/outside batch B2 would run first: 20261012000001/)
  })
})

describe('D-05 postconditions (pure)', () => {
  const check = batches.POSTCONDITIONS.D05_MEMBER_IDENTITY

  test('accepts exactly the four contract indexes with no historical object', () => {
    expect(check(D05_STATE)).toEqual({ ok: true, failures: [] })
  })

  test('missing target index fails', () => {
    const { uq_member_phone_e164: _omitted, ...rest } = D05_DEFS
    const r = check({ ...D05_STATE, indexDefs: rest })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(/uq_member_phone_e164 missing/)
  })

  test('non-unique or wrong-predicate index fails', () => {
    const r = check({
      ...D05_STATE,
      indexDefs: {
        ...D05_DEFS,
        uq_member_phone_e164: 'CREATE INDEX uq_member_phone_e164 ON public.member USING btree ("phoneNumber")',
        uq_member_email_ci: D05_DEFS.uq_member_email_ci.replace(' AND (email IS NOT NULL)', '')
      }
    })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(/uq_member_phone_e164 is not UNIQUE/)
    expect(r.failures.join('\n')).toMatch(/uq_member_email_ci definition lacks "\(email IS NOT NULL\)"/)
  })

  test('surviving historical uniqueness constraint or index fails', () => {
    const r = check({
      indexDefs: { ...D05_DEFS, uq_member_global_name: 'CREATE UNIQUE INDEX uq_member_global_name ON public.member (name)' },
      constraintNames: ['member_pkey', 'uq_member_phoneNumber'],
      nonCanonicalActivePhones: 0
    })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(/historical uq_member_global_name still present/)
    expect(r.failures.join('\n')).toMatch(/historical uq_member_phoneNumber still present/)
  })

  test('unavailable state fails closed', () => {
    expect(check(undefined).ok).toBe(false)
    expect(check({ indexDefs: null, constraintNames: [] }).ok).toBe(false)
    expect(check({ ...D05_STATE, nonCanonicalActivePhones: undefined }).ok).toBe(false)
  })

  test('backfill postcondition: any active non-guest phone not in E.164 form fails', () => {
    const r = check({ ...D05_STATE, nonCanonicalActivePhones: 2 })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(/2 active non-guest phone\(s\) not in E\.164 form/)
  })

  test('index on another table or access method fails', () => {
    const r = check({
      ...D05_STATE,
      indexDefs: { ...D05_DEFS, uq_member_email_ci: D05_DEFS.uq_member_email_ci.replace('ON public.member USING btree', 'ON public.member_archive USING btree') }
    })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(/uq_member_email_ci definition lacks "ON public.member USING btree "/)
  })
})

describe('D-08 runner --resume B1-D05', () => {
  const okPreflight = (state) => ({
    resolveEnv: preflight.resolveEnv,
    report: () => {},
    runPreflight: jest.fn(async ({ env }) => ({ env, ok: true, applicable: true, reasons: [], ...state }))
  })
  const run = (opts) =>
    runner.main({
      argv: ['--env', 'production', '--resume', 'B1-D05'],
      preflight: okPreflight({ files: FILES, metaNames: INCIDENT }),
      resumes: gateCleared(),
      readPostconditionState: async () => D05_STATE,
      // never fall through to the real sequelize-cli or a real database
      spawn: () => {
        throw new Error('spawn not injected')
      },
      readMeta: async () => {
        throw new Error('readMeta not injected')
      },
      ...opts
    })
  const records = (spy) =>
    spy.mock.calls
      .map((c) => c.join(' '))
      .filter((l) => l.startsWith('[migrate] RESUME RECORD '))
      .map((l) => JSON.parse(l.slice('[migrate] RESUME RECORD '.length)))
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

  test('happy path: spawns bounded to D-05, verifies 235 → 236 and postconditions, emits one record', async () => {
    const spawn = jest.fn(() => ({ status: 0 }))
    const readMeta = jest.fn(async () => [...INCIDENT, D05])
    const readPostconditionState = jest.fn(async () => D05_STATE)
    const code = await run({ spawn, readMeta, readPostconditionState })
    expect(code).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('production', { to: D05 })
    expect(readMeta).toHaveBeenCalledWith('production')
    expect(readPostconditionState).toHaveBeenCalledWith('production', 'D05_MEMBER_IDENTITY')
    const [rec] = records(logSpy)
    expect(rec).toMatchObject({
      resume: 'B1-D05',
      batch: 'B1',
      env: 'production',
      outcome: 'RECORDED',
      exitCode: 0,
      runnerStatus: 0,
      to: D05,
      ledgerBefore: 235,
      ledgerAfter: 236,
      added: [D05],
      postconditions: { id: 'D05_MEMBER_IDENTITY', ok: true, failures: [] }
    })
    // the record carries the exact observed index definitions as schema evidence
    expect(rec.postconditions.observed).toEqual({
      indexDefs: {
        uq_member_store_name_ci: D05_DEFS.uq_member_store_name_ci,
        uq_member_global_name_ci: D05_DEFS.uq_member_global_name_ci,
        uq_member_phone_e164: D05_DEFS.uq_member_phone_e164,
        uq_member_email_ci: D05_DEFS.uq_member_email_ci
      },
      constraintNames: ['member_pkey'],
      nonCanonicalActivePhones: 0
    })
    expect(rec.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(rec.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('real contract proceeds past gate evaluation now that the gate is cleared', async () => {
    const spawn = jest.fn(() => ({ status: 0 }))
    const readMeta = jest.fn(async () => [...INCIDENT, D05])
    const code = await run({ spawn, readMeta, resumes: undefined })
    expect(code).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('production', { to: D05 })
    expect(readMeta).toHaveBeenCalledWith('production')
  })

  test('D-05 preflight abort (runner exit 1, ledger unchanged) is propagated and recorded', async () => {
    const code = await run({ spawn: () => ({ status: 1 }), readMeta: async () => [...INCIDENT] })
    expect(code).toBe(1)
    const [rec] = records(logSpy)
    expect(rec).toMatchObject({ outcome: 'RUNNER_FAILED', runnerStatus: 1, ledgerAfter: 235, added: [] })
    expect(rec.postconditions).toBeNull()
  })

  test('post-run ledger mismatch (extra row) fails with exit 1 and skips postconditions', async () => {
    const readPostconditionState = jest.fn()
    const code = await run({
      spawn: () => ({ status: 0 }),
      readMeta: async () => [...INCIDENT, D05, M1],
      readPostconditionState
    })
    expect(code).toBe(1)
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/POST-RUN LEDGER MISMATCH/)
    expect(readPostconditionState).not.toHaveBeenCalled()
    expect(records(logSpy)[0]).toMatchObject({ outcome: 'LEDGER_MISMATCH', ledgerAfter: 237 })
  })

  test('post-run ledger count must be exactly 236 even if D-05 was added', async () => {
    const code = await run({
      spawn: () => ({ status: 0 }),
      readMeta: async () => [...INCIDENT.slice(1), D05]
    })
    expect(code).toBe(1)
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/POST-RUN LEDGER MISMATCH.*expected 236/s)
  })

  test('postcondition failure fails the run (exit 1) and is recorded', async () => {
    const { uq_member_email_ci: _omitted, ...rest } = D05_DEFS
    const code = await run({
      spawn: () => ({ status: 0 }),
      readMeta: async () => [...INCIDENT, D05],
      readPostconditionState: async () => ({ indexDefs: rest, constraintNames: ['member_pkey'], nonCanonicalActivePhones: 0 })
    })
    expect(code).toBe(1)
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/POST-RUN POSTCONDITION FAILURE.*uq_member_email_ci missing/s)
    expect(records(logSpy)[0]).toMatchObject({ outcome: 'POSTCONDITION_FAILED', exitCode: 1 })
  })

  test('post-run ledger re-read error fails closed with an actionable record (exit 1)', async () => {
    const readPostconditionState = jest.fn()
    const code = await run({
      spawn: () => ({ status: 0 }),
      readMeta: async () => {
        throw new Error('ECONNRESET')
      },
      readPostconditionState
    })
    expect(code).toBe(1)
    expect(readPostconditionState).not.toHaveBeenCalled()
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/LEDGER UNVERIFIED.*ECONNRESET.*verify SequelizeMeta read-only/s)
    expect(records(logSpy)[0]).toMatchObject({ outcome: 'LEDGER_UNVERIFIED', exitCode: 1, runnerStatus: 0, ledgerAfter: null })
  })

  test('ledger re-read error after a failed runner keeps the runner status', async () => {
    const code = await run({
      spawn: () => ({ status: 3 }),
      readMeta: async () => {
        throw new Error('timeout')
      }
    })
    expect(code).toBe(3)
    expect(records(logSpy)[0]).toMatchObject({ outcome: 'LEDGER_UNVERIFIED', exitCode: 3, runnerStatus: 3 })
  })

  test('default postcondition reader is the read-only member reader for D05_MEMBER_IDENTITY', async () => {
    const pf = {
      ...okPreflight({ files: FILES, metaNames: INCIDENT }),
      readMemberIdentityObjects: jest.fn(async () => D05_STATE)
    }
    const code = await runner.main({
      argv: ['--env', 'production', '--resume', 'B1-D05'],
      preflight: pf,
      resumes: gateCleared(),
      spawn: () => ({ status: 0 }),
      readMeta: async () => [...INCIDENT, D05]
    })
    expect(code).toBe(0)
    expect(pf.readMemberIdentityObjects).toHaveBeenCalledWith('production')
  })

  test('default postcondition reader refuses an unknown postcondition id', async () => {
    await expect(runner.defaultReadPostconditionState({}, 'production', 'NOPE')).rejects.toThrow(/no read-only reader for postcondition "NOPE"/)
  })

  test('postcondition reader error fails closed (exit 1)', async () => {
    const code = await run({
      spawn: () => ({ status: 0 }),
      readMeta: async () => [...INCIDENT, D05],
      readPostconditionState: async () => {
        throw new Error('connection reset')
      }
    })
    expect(code).toBe(1)
    expect(records(logSpy)[0].postconditions.failures.join('\n')).toMatch(/connection reset/)
  })

  test('preflight refusal blocks a resume (D-08 preflight stays authoritative)', async () => {
    const spawn = jest.fn()
    const pf = {
      resolveEnv: preflight.resolveEnv,
      report: () => {},
      runPreflight: jest.fn(async ({ env }) => ({ env, ok: false, applicable: true, reasons: ['manifest sha mismatch'] }))
    }
    const code = await run({ preflight: pf, spawn })
    expect(code).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('--resume is refused for a non-governed (local) environment', async () => {
    const spawn = jest.fn()
    const pf = {
      resolveEnv: preflight.resolveEnv,
      report: () => {},
      runPreflight: jest.fn(async ({ env }) => ({ env, ok: true, applicable: false, reasons: [] }))
    }
    const code = await run({ argv: ['--env', 'development', '--resume', 'B1-D05'], preflight: pf, spawn })
    expect(code).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('argument rules: --resume with --batch, twice, unknown, or empty is refused before preflight', async () => {
    for (const argv of [
      ['--env', 'production', '--resume', 'B1-D05', '--batch', 'B2'],
      ['--env', 'production', '--batch', 'B1', '--resume', 'B1-D05'],
      ['--env', 'production', '--resume', 'B1-D05', '--resume=B1-D05'],
      ['--env', 'production', '--resume', 'B1'],
      ['--env', 'production', '--resume'],
      ['--env', 'production', '--resume', '--to', D05]
    ]) {
      const pf = okPreflight({ files: FILES, metaNames: INCIDENT })
      const spawn = jest.fn()
      const code = await runner.main({ argv, preflight: pf, spawn, readMeta: jest.fn(), resumes: gateCleared() })
      expect(code).toBe(1)
      expect(pf.runPreflight).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    }
    expect(runner.parseArgs(['--env', 'production', '--resume=B1-D05'])).toEqual({ env: 'production', batch: null, resume: 'B1-D05' })
  })

  test('unbatched run in the incident state is still refused (D-05 is a pending batch member)', async () => {
    const spawn = jest.fn()
    const code = await runner.main({
      argv: ['--env', 'production'],
      preflight: okPreflight({ files: FILES, metaNames: INCIDENT }),
      spawn
    })
    expect(code).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('read-only postcondition reader', () => {
  test('reads member index/constraint state inside a READ ONLY transaction and never writes', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-migration-preflight.js'), 'utf8')
    expect(typeof preflight.readMemberIdentityObjects).toBe('function')
    expect(src).toMatch(/SET TRANSACTION READ ONLY/)
    expect(src).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+"?\w+"?\s+SET|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+(TABLE|INDEX)|CREATE\s+(TABLE|INDEX|UNIQUE))\b/i)
  })

  test('the resume contract and runner never write SequelizeMeta themselves', () => {
    for (const f of ['migration-batches.js', 'run-migrations.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8')
      expect(src).not.toMatch(/INSERT\s+INTO\s+"?SequelizeMeta/i)
      expect(src).not.toMatch(/DELETE\s+FROM\s+"?SequelizeMeta/i)
    }
  })
})
