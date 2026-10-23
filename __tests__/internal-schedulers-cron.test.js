process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const fs = require('fs')
const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')
const expenseScheduler = require('../api/service/expenseScheduler')
const shiftSwapScheduler = require('../api/service/shiftSwapScheduler')
const apReminderService = require('../api/service/apReminderService')
const { tryAcquireSchedulerLock } = require('../utils/schedulerLock')

// FG-PLAT-04: the in-process schedulers never start on Vercel, so the three
// remaining jobs need the same CRON_SECRET-authenticated, lease-guarded
// endpoints as the accounting outbox and backup. Hobby only accepts daily
// crons; all six jobs therefore run at 00:00.

const SECRET = 's'.repeat(40)

const LEASES = ['expense', 'shift-swap', 'ap-reminder']
const clearLeases = () =>
  db.sequelize.query(
    `DELETE FROM scheduler_lock WHERE name IN (${LEASES.map((lease) => `'${lease}'`).join(', ')})`
  )

const run = (path, auth) => {
  const req = request(app).get(path)
  return auth ? req.set('Authorization', auth) : req
}

beforeEach(async () => {
  await clearLeases()
  process.env.CRON_SECRET = SECRET
})

afterAll(async () => {
  delete process.env.CRON_SECRET
  await clearLeases()
})

describe('internal scheduler endpoints — auth', () => {
  test.each([
    '/internal/expense-recurrence/run',
    '/internal/shift-swaps/expire',
    '/internal/ap-reminders/run'
  ])('%s fails closed without a configured secret', async (path) => {
    delete process.env.CRON_SECRET
    const res = await run(path, `Bearer ${SECRET}`)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('CRON_NOT_CONFIGURED')
  })

  test.each([
    '/internal/expense-recurrence/run',
    '/internal/shift-swaps/expire',
    '/internal/ap-reminders/run'
  ])('%s rejects a missing or wrong bearer token', async (path) => {
    expect((await run(path)).status).toBe(401)
    expect((await run(path, `Bearer ${'x'.repeat(40)}`)).status).toBe(401)
  })
})

describe('internal scheduler endpoints — work', () => {
  test('recurring expenses delegate to the scheduler and report the generated count', async () => {
    const spy = jest
      .spyOn(expenseScheduler, 'generateDueRecurringExpenses')
      .mockResolvedValue(3)
    try {
      const res = await run('/internal/expense-recurrence/run', `Bearer ${SECRET}`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ skipped: false, generated: 3 })
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  test('shift swaps delegate to the expiry sweep and report the expired count', async () => {
    const spy = jest
      .spyOn(shiftSwapScheduler, 'expirePendingSwaps')
      .mockResolvedValue(2)
    try {
      const res = await run('/internal/shift-swaps/expire', `Bearer ${SECRET}`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ skipped: false, expired: 2 })
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  test('AP reminders delegate with the bounded batch and return the summary', async () => {
    const summary = {
      evaluated: 5,
      eligible: 2,
      created: 1,
      skippedDuplicate: 1
    }
    const spy = jest
      .spyOn(apReminderService, 'generateApReminders')
      .mockResolvedValue(summary)
    try {
      const res = await run('/internal/ap-reminders/run', `Bearer ${SECRET}`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ skipped: false, ...summary })
      expect(spy).toHaveBeenCalledWith({ limit: 200 })
    } finally {
      spy.mockRestore()
    }
  })

  test.each([
    ['/internal/expense-recurrence/run', 'expense', 'generateDueRecurringExpenses'],
    ['/internal/shift-swaps/expire', 'shift-swap', 'expirePendingSwaps'],
    ['/internal/ap-reminders/run', 'ap-reminder', 'generateApReminders']
  ])('%s skips while its lease is held', async (path, lease, method) => {
    const module =
      lease === 'expense'
        ? expenseScheduler
        : lease === 'shift-swap'
          ? shiftSwapScheduler
          : apReminderService
    const spy = jest.spyOn(module, method).mockResolvedValue(0)
    await tryAcquireSchedulerLock(db, lease, 60000)
    try {
      const res = await run(path, `Bearer ${SECRET}`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ skipped: true, reason: 'LEASE_HELD' })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('vercel.json scheduler contract', () => {
  const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'))

  test('all six internal jobs are scheduled daily', () => {
    const byPath = Object.fromEntries(
      (vercel.crons || []).map((c) => [c.path, c.schedule])
    )
    for (const path of [
      '/internal/accounting-outbox/drain',
      '/internal/qr-orders/expire',
      '/internal/backup/run',
      '/internal/expense-recurrence/run',
      '/internal/shift-swaps/expire',
      '/internal/ap-reminders/run'
    ]) {
      expect(byPath[path]).toBe('0 0 * * *')
    }
    expect(Object.keys(byPath)).toHaveLength(6)
  })

  test('every cron targets /internal and respects the 15-minute floor', () => {
    for (const cron of vercel.crons || []) {
      expect(cron.path.startsWith('/internal/')).toBe(true)
      const [minute] = cron.schedule.split(' ')
      if (minute.startsWith('*/')) {
        expect(Number(minute.slice(2))).toBeGreaterThanOrEqual(15)
      }
    }
  })
})
