process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let adminToken = null
let cashAccountId = null
let revenueAccountId = null

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'ACC_FLOW_STORE', status: 'active' }))
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7501,
    userName: 'admin_acc_flow',
    email: 'p14-7501-accounting-journal-flow@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_acc_flow'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7501, userName: 'admin_acc_flow', roleType: 'admin', store: location.id },
    JWT_SECRET
  )

  const cashRes = await request(app)
    .post('/accounting/accounts')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      code: 'TEST-CASH',
      name: 'Test Cash',
      type: 'asset',
      normalBalance: 'debit'
    })
  cashAccountId = cashRes.body.data.id

  const revenueRes = await request(app)
    .post('/accounting/accounts')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      code: 'TEST-REV',
      name: 'Test Sales Revenue',
      type: 'revenue',
      normalBalance: 'credit'
    })
  revenueAccountId = revenueRes.body.data.id
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [7501] }, force: true })
  await db.journal_entry_line.destroy({ where: {}, force: true })
  await db.journal_entry.destroy({ where: { store: location.id }, force: true })
  await db.account.destroy({ where: { store: location.id }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

describe('POST /accounting/journals — double-entry journal posting', () => {
  test('creates a balanced journal entry with all lines committed together', async () => {
    const res = await request(app)
      .post('/accounting/journals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        date: new Date().toISOString().slice(0, 10),
        description: 'Test cash sale',
        lines: [
          { account: cashAccountId, debit: 100000, credit: 0 },
          { account: revenueAccountId, debit: 0, credit: 100000 }
        ]
      })

    expect(res.status).toBe(201)
    expect(Number(res.body.data.totalDebit)).toBe(100000)
    expect(Number(res.body.data.totalCredit)).toBe(100000)

    // Header and lines are written in one transaction — both or neither.
    const lines = await db.journal_entry_line.findAll({
      where: { journalEntry: res.body.data.id }
    })
    expect(lines.length).toBe(2)
  })

  test('rejects an unbalanced journal entry and writes nothing', async () => {
    const beforeCount = await db.journal_entry.count({
      where: { store: location.id }
    })

    const res = await request(app)
      .post('/accounting/journals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        date: new Date().toISOString().slice(0, 10),
        description: 'Unbalanced entry',
        lines: [
          { account: cashAccountId, debit: 50000, credit: 0 },
          { account: revenueAccountId, debit: 0, credit: 40000 }
        ]
      })

    expect(res.status).toBe(400)

    const afterCount = await db.journal_entry.count({
      where: { store: location.id }
    })
    expect(afterCount).toBe(beforeCount)
  })

  test('trial balance reflects the posted journal and stays balanced', async () => {
    const res = await request(app)
      .get('/accounting/trial-balance')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.balanced).toBe(true)

    const cashRow = res.body.data.find((r) => r.code === 'TEST-CASH')
    const revRow = res.body.data.find((r) => r.code === 'TEST-REV')
    expect(Number(cashRow.debit)).toBe(100000)
    expect(Number(revRow.credit)).toBe(100000)
  })
})
