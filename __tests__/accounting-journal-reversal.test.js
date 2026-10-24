process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// FG-ACC-03: deleting a manual journal reverses it instead of removing it
// from the books; automatic journals cannot be touched from here.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const USER_ID = 7611

let location = null
let token = null
let cashAccountId = null
let revenueAccountId = null

const auth = (req) => req.set('Authorization', `Bearer ${token}`)

const postManual = (amount, description = 'FG-ACC-03 manual') =>
  auth(request(app).post('/accounting/journals')).send({
    date: '2026-10-01',
    description,
    lines: [
      { account: cashAccountId, debit: amount, credit: 0, description: 'cash in' },
      { account: revenueAccountId, debit: 0, credit: amount }
    ]
  })

const waitForAudit = async (entityId) => {
  for (let i = 0; i < 20; i++) {
    const row = await db.auditLog.findOne({
      where: { userId: USER_ID, entity: 'journal_entry', entityId: String(entityId), action: 'delete' }
    })
    if (row) return row
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

beforeAll(async () => {
  location = await db.location.create({
    name: 'ACC_REVERSAL_STORE',
    status: 'active',
    timezone: 'Asia/Jakarta'
  })
  await db.user.create({
    id: USER_ID,
    userName: 'admin_acc_reversal',
    email: 'fg-acc-03-7611@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_acc_reversal'
  })
  token = await signSessionToken(
    { id: USER_ID, userName: 'admin_acc_reversal', roleType: 'admin', store: location.id },
    JWT_SECRET
  )
  const cash = await auth(request(app).post('/accounting/accounts')).send({
    code: 'REV-CASH',
    name: 'Reversal Cash',
    type: 'asset',
    normalBalance: 'debit'
  })
  cashAccountId = cash.body.data.id
  const revenue = await auth(request(app).post('/accounting/accounts')).send({
    code: 'REV-SALES',
    name: 'Reversal Sales',
    type: 'revenue',
    normalBalance: 'credit'
  })
  revenueAccountId = revenue.body.data.id
})

afterAll(async () => {
  const entries = await db.journal_entry.findAll({
    where: { store: location.id },
    attributes: ['id'],
    paranoid: false
  })
  await db.journal_entry_line.destroy({
    where: { journalEntry: entries.map((e) => e.id) },
    force: true
  })
  await db.journal_entry.destroy({ where: { store: location.id }, force: true })
  await db.sequelize.query('DELETE FROM journal_entry_sequence WHERE store = $1', {
    bind: [location.id]
  })
  await db.account.destroy({ where: { store: location.id }, force: true })
  await db.auditLog.destroy({ where: { userId: USER_ID }, force: true, __auditMaintenance: true })
  await db.user.destroy({ where: { id: USER_ID }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

describe('DELETE /accounting/journals/:id — reversal, not removal', () => {
  let original = null

  test('reverses a manual journal: original kept as reversed, mirror entry posted, audited', async () => {
    const created = await postManual(1000000)
    expect(created.status).toBe(201)
    original = created.body.data

    const res = await auth(request(app).delete(`/accounting/journals/${original.id}`)).send({
      reason: 'salah input'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.reversal.sourceType).toBe('manual_reversal')

    const kept = await db.journal_entry.findByPk(original.id)
    expect(kept).not.toBeNull()
    expect(kept.status).toBe('reversed')

    const reversal = await db.journal_entry.findOne({
      where: { store: location.id, sourceType: 'manual_reversal', referenceId: original.id },
      include: [{ model: db.journal_entry_line, as: 'lines' }]
    })
    expect(reversal.status).toBe('posted')
    expect(reversal.description).toBe(`Reversal of ${original.entryNumber}: salah input`)
    expect(Number(reversal.totalDebit)).toBe(1000000)
    // Never dated before the entry it reverses.
    expect(reversal.date >= kept.date).toBe(true)
    const byAccount = Object.fromEntries(
      reversal.lines.map((l) => [String(l.account), [Number(l.debit), Number(l.credit)]])
    )
    expect(byAccount[String(cashAccountId)]).toEqual([0, 1000000])
    expect(byAccount[String(revenueAccountId)]).toEqual([1000000, 0])

    const audit = await waitForAudit(original.id)
    expect(audit).not.toBeNull()
    expect(audit.description).toContain(reversal.entryNumber)
    expect(audit.description).toContain('salah input')
  })

  test('trial balance keeps both entries and nets the pair to zero', async () => {
    const res = await auth(request(app).get('/accounting/trial-balance'))
    expect(res.status).toBe(200)
    expect(res.body.balanced).toBe(true)
    const cash = res.body.data.find((r) => r.code === 'REV-CASH')
    const sales = res.body.data.find((r) => r.code === 'REV-SALES')
    expect(Number(cash.debit)).toBe(1000000)
    expect(Number(cash.credit)).toBe(1000000)
    expect(Number(sales.debit)).toBe(1000000)
    expect(Number(sales.credit)).toBe(1000000)

    // The period of the original still shows it.
    const october1 = await auth(
      request(app).get('/accounting/trial-balance?startDate=2026-10-01&endDate=2026-10-01')
    )
    const cashOct1 = october1.body.data.find((r) => r.code === 'REV-CASH')
    expect(Number(cashOct1.debit)).toBe(1000000)
  })

  test('a second reversal is refused and posts nothing', async () => {
    const res = await auth(request(app).delete(`/accounting/journals/${original.id}`))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('JOURNAL_ALREADY_REVERSED')
    const reversals = await db.journal_entry.count({
      where: { store: location.id, sourceType: 'manual_reversal', referenceId: original.id }
    })
    expect(reversals).toBe(1)
  })

  test('the reversal entry itself cannot be reversed', async () => {
    const reversal = await db.journal_entry.findOne({
      where: { store: location.id, sourceType: 'manual_reversal', referenceId: original.id }
    })
    const res = await auth(request(app).delete(`/accounting/journals/${reversal.id}`))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('JOURNAL_NOT_MANUAL')
  })

  test('an automatic journal is refused and left untouched', async () => {
    const auto = await db.journal_entry.create({
      store: location.id,
      entryNumber: `JV-AUTO-${location.id}`,
      date: '2026-10-02',
      description: 'order posting',
      sourceType: 'order',
      referenceId: 999001,
      totalDebit: 5000,
      totalCredit: 5000
    })
    const res = await auth(request(app).delete(`/accounting/journals/${auto.id}`))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('JOURNAL_NOT_MANUAL')
    const after = await db.journal_entry.findByPk(auto.id)
    expect(after.status).toBe('posted')
  })

  test('an unknown journal is 404', async () => {
    const res = await auth(request(app).delete('/accounting/journals/987654321'))
    expect(res.status).toBe(404)
  })
})

describe('POST /accounting/journals — entry numbers come from the per-store counter', () => {
  test('a manual entry takes the next counter value, like automatic postings', async () => {
    const [rows] = await db.sequelize.query(
      'SELECT counter FROM journal_entry_sequence WHERE store = $1',
      { bind: [location.id] }
    )
    const before = Number(rows[0]?.counter || 0)
    const res = await postManual(25000, 'counter check')
    expect(res.status).toBe(201)
    const expected = `JV-${String(location.id).padStart(4, '0')}-${String(before + 1).padStart(6, '0')}`
    expect(res.body.data.entryNumber).toBe(expected)
  })
})
