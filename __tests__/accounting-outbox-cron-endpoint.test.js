process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')
const { MAX_ATTEMPTS } = require('../api/service/accountingOutboxService')

// DR-10 / BA TP-04: on Vercel no in-process scheduler drains the accounting
// outbox, so a journal whose immediate post-commit attempt failed is never
// retried. GET /internal/accounting-outbox/{drain,health} let an external
// cron (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`) do it. They
// fail closed until CRON_SECRET is configured.

const SECRET = 's'.repeat(40)
const REF = 'cron_endpoint_test'
const clearLease = () =>
  db.sequelize.query(`DELETE FROM scheduler_lock WHERE name = 'accounting-outbox'`)

// An unknown jobType always fails to post: a deterministic "transient
// failure" for the drain to retry. Backdated so the oldest-first drain
// claims it before any leftover rows from other suites.
const failingJob = async (attempts = 0) => {
  const row = await db.accounting_outbox.create({
    jobType: 'cron_test_unknown_job',
    referenceType: REF,
    referenceId: 1,
    payload: { secret: 'payload-must-not-leak' },
    attempts
  })
  await db.sequelize.query(
    `UPDATE accounting_outbox SET "createdAt" = '2000-01-01' WHERE id = :id`,
    { replacements: { id: row.id } }
  )
  return row
}

const drain = (auth) => {
  const req = request(app).get('/internal/accounting-outbox/drain')
  return auth ? req.set('Authorization', auth) : req
}

beforeEach(async () => {
  await clearLease()
  process.env.CRON_SECRET = SECRET
})

afterAll(async () => {
  delete process.env.CRON_SECRET
  await db.accounting_outbox.destroy({ where: { referenceType: REF }, force: true })
  await clearLease()
})

describe('internal accounting-outbox endpoints', () => {
  test('without a configured secret every call is refused and nothing is drained', async () => {
    delete process.env.CRON_SECRET
    const row = await failingJob()
    const res = await drain(`Bearer ${SECRET}`)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('CRON_NOT_CONFIGURED')
    expect((await row.reload()).attempts).toBe(0)

    process.env.CRON_SECRET = 'too-short'
    expect((await drain('Bearer too-short')).status).toBe(503)
  })

  test('a missing or wrong bearer token is refused', async () => {
    expect((await drain()).status).toBe(401)
    expect((await drain(`Bearer ${'x'.repeat(40)}`)).status).toBe(401)
    expect((await drain(SECRET)).status).toBe(401)
    expect((await request(app).get('/internal/accounting-outbox/health')).status).toBe(401)
  })

  test('an authorized drain retries a failed job with bounded attempts and reports health', async () => {
    const row = await failingJob()
    const res = await drain(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect(res.body.skipped).toBe(false)
    expect(res.body.processed).toBeGreaterThanOrEqual(1)
    await row.reload()
    expect(row.attempts).toBe(1)
    expect(row.status).toBe('pending')
    expect(res.body.health.pending).toBeGreaterThanOrEqual(1)
    expect(res.body.health.oldestPendingAgeSeconds).toBeGreaterThan(0)
  })

  test('exhausted retries become `failed` and are listed without payload or error text', async () => {
    const row = await failingJob(MAX_ATTEMPTS - 1)
    expect((await drain(`Bearer ${SECRET}`)).status).toBe(200)
    await row.reload()
    expect(row.status).toBe('failed')

    const health = await request(app)
      .get('/internal/accounting-outbox/health')
      .set('Authorization', `Bearer ${SECRET}`)
    expect(health.status).toBe(200)
    expect(health.body.failed).toBeGreaterThanOrEqual(1)
    const listed = health.body.failedJobs.find((j) => j.id === row.id)
    expect(listed).toMatchObject({ jobType: 'cron_test_unknown_job', referenceType: REF })
    expect(listed).not.toHaveProperty('payload')
    expect(listed).not.toHaveProperty('lastError')
    expect(JSON.stringify(health.body)).not.toContain('payload-must-not-leak')
  })

  test('concurrent drains: one holds the lease, the other is skipped', async () => {
    const [a, b] = await Promise.all([drain(`Bearer ${SECRET}`), drain(`Bearer ${SECRET}`)])
    expect([a.status, b.status]).toEqual([200, 200])
    const skipped = [a.body, b.body].filter((body) => body.skipped)
    expect(skipped).toHaveLength(1)
    expect(skipped[0].reason).toBe('LEASE_HELD')
  })
})
