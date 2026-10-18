process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'
// Isolate the backup schedule file: the endpoint must observe the default
// "disabled" schedule instead of any real deployment file in ./backups.
process.env.BACKUP_DIR = require('path').join(
  require('os').tmpdir(),
  `c24c-backup-${process.pid}`
)

const fs = require('fs')
const path = require('path')

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')
const backupController = require('../api/controller/backup')
const { tryAcquireSchedulerLock } = require('../utils/schedulerLock')

// DR-24 C-24c / DR-10 pattern: on Vercel the in-process backup scheduler never
// starts, so /internal/backup/run lets Vercel Cron drive the DB-configured
// backup schedule. It shares the fail-closed CRON_SECRET gate and the 'backup'
// scheduler lease, and vercel.json must actually schedule all three internal
// jobs. The Vercel project runs on Hobby, which refuses crons that fire more
// than once per day (deployment fails), so all three are daily; the backup
// endpoint catches up when the last scheduled backup is stale because Hobby
// fires crons anywhere within the scheduled hour (no exact-minute match).
// Upgrade path: on Vercel Pro, drain/expiry can go back to */15 (L-07 floor).

const SECRET = 's'.repeat(40)
const SCHEDULE_FILE = path.join(process.env.BACKUP_DIR, '.schedule.json')
const writeSchedule = (schedule) => {
  fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true })
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule), 'utf8')
}
const clearBackupLease = () =>
  db.sequelize.query(`DELETE FROM scheduler_lock WHERE name = 'backup'`)

const run = (auth) => {
  const req = request(app).get('/internal/backup/run')
  return auth ? req.set('Authorization', auth) : req
}

beforeEach(async () => {
  await clearBackupLease()
  process.env.CRON_SECRET = SECRET
})

afterEach(() => {
  fs.rmSync(SCHEDULE_FILE, { force: true })
})

afterAll(async () => {
  delete process.env.CRON_SECRET
  await clearBackupLease()
  fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true })
})

describe('internal backup cron endpoint', () => {
  test('without a configured secret every call is refused', async () => {
    delete process.env.CRON_SECRET
    const res = await run(`Bearer ${SECRET}`)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('CRON_NOT_CONFIGURED')

    process.env.CRON_SECRET = 'too-short'
    expect((await run('Bearer too-short')).status).toBe(503)
  })

  test('a missing or wrong bearer token is refused', async () => {
    expect((await run()).status).toBe(401)
    expect((await run(`Bearer ${'x'.repeat(40)}`)).status).toBe(401)
    expect((await run(SECRET)).status).toBe(401)
  })

  test('an authorized call with the schedule disabled reports ran=false without backing up', async () => {
    const res = await run(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect(res.body.skipped).toBe(false)
    expect(res.body.ran).toBe(false)
    expect(res.body.reason).toBe('SCHEDULE_DISABLED')
    expect(await db.db_backup.count({ where: { trigger: 'scheduled' } })).toBe(0)
  })

  test('a held backup lease skips the run', async () => {
    await tryAcquireSchedulerLock(db, 'backup', 60000)
    const res = await run(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect(res.body.skipped).toBe(true)
    expect(res.body.reason).toBe('LEASE_HELD')
  })

  test('when the schedule is due the run is delegated to the shared backup path', async () => {
    const spy = jest
      .spyOn(backupController, 'runScheduledBackupIfDue')
      .mockResolvedValue(true)
    try {
      const res = await run(`Bearer ${SECRET}`)
      expect(res.status).toBe(200)
      expect(res.body.skipped).toBe(false)
      expect(res.body.ran).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  test('an enabled schedule with no recent backup catches up (Hobby hour-jitter)', async () => {
    await db.db_backup.destroy({ where: { trigger: 'scheduled' } })
    writeSchedule({ enabled: true, cron: '0 0 * * *', retention: 7 })
    const dueSpy = jest
      .spyOn(backupController, 'runScheduledBackupIfDue')
      .mockResolvedValue(false)
    const runSpy = jest
      .spyOn(backupController, 'runScheduledBackup')
      .mockResolvedValue(true)
    try {
      const res = await run(`Bearer ${SECRET}`)
      expect(res.status).toBe(200)
      expect(res.body.skipped).toBe(false)
      expect(res.body.ran).toBe(true)
      expect(res.body.catchUp).toBe(true)
      expect(runSpy).toHaveBeenCalledTimes(1)
    } finally {
      dueSpy.mockRestore()
      runSpy.mockRestore()
    }
  })

  test('a fresh scheduled backup suppresses the catch-up run', async () => {
    writeSchedule({ enabled: true, cron: '0 0 * * *', retention: 7 })
    const row = await db.db_backup.create({
      filename: 'catchup-guard.dump',
      filepath: '/tmp/catchup-guard.dump',
      size: 1,
      format: 'custom',
      status: 'success',
      trigger: 'scheduled',
      store: null,
      createdBy: null,
      metadata: { source: 'scheduler', globalDump: true }
    })
    const dueSpy = jest
      .spyOn(backupController, 'runScheduledBackupIfDue')
      .mockResolvedValue(false)
    const runSpy = jest
      .spyOn(backupController, 'runScheduledBackup')
      .mockResolvedValue(true)
    try {
      const res = await run(`Bearer ${SECRET}`)
      expect(res.status).toBe(200)
      expect(res.body.skipped).toBe(false)
      expect(res.body.ran).toBe(false)
      expect(res.body.reason).toBe('NOT_DUE')
      expect(runSpy).not.toHaveBeenCalled()
    } finally {
      dueSpy.mockRestore()
      runSpy.mockRestore()
      await row.destroy()
    }
  })
})

describe('vercel.json cron contract', () => {
  const vercel = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8')
  )

  test('all three internal jobs are scheduled daily (Hobby plan refuses more-than-daily crons)', () => {
    const byPath = Object.fromEntries(
      (vercel.crons || []).map((c) => [c.path, c.schedule])
    )
    expect(byPath['/internal/accounting-outbox/drain']).toBe('0 0 * * *')
    expect(byPath['/internal/qr-orders/expire']).toBe('0 0 * * *')
    expect(byPath['/internal/backup/run']).toBe('0 0 * * *')
    // Upgrade path on Vercel Pro: drain/expiry may go back to */15 (L-07 floor).
  })

  test('no cron is tighter than the 15-minute floor and all target /internal', () => {
    for (const cron of vercel.crons || []) {
      expect(cron.path.startsWith('/internal/')).toBe(true)
      const [minute] = cron.schedule.split(' ')
      if (minute.startsWith('*/')) {
        expect(Number(minute.slice(2))).toBeGreaterThanOrEqual(15)
      }
    }
  })
})
