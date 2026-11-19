process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// N1 regression: POST /accounts-receivable/create must obey the same
// integer-money contract as recordPayment in the same controller
// (assertIntegerRupiah → 422). In particular it must NEVER silently
// truncate a fractional totalAmount via parseInt (100000.5 → 100000).

let store1 = null
let order1 = null
let admin1Token = null

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({ name: 'N1_STORE_A' }))

  const suffix = Date.now()
  const user1 = await db.user.create({
    id: 9861,
    userName: `n1_admin_a_${suffix}`,
    roleType: 'admin',
    store: store1.id,
    password: 'x'
  })
  admin1Token = await signSessionToken(
    { id: user1.id, userName: user1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )

  order1 = await db.order.create({
    orderNumber: `N1-${Date.now()}-A`,
    store: store1.id,
    status: 'pending',
    paymentStatus: 'unpaid',
    customerName: 'N1 Customer',
    source: 'pos'
  })
})

afterAll(async () => {
  await db.accounts_receivable.destroy({
    where: { orderId: [order1?.id].filter(Boolean) },
    force: true
  })
  await db.order.destroy({
    where: { id: [order1?.id].filter(Boolean) },
    force: true
  })
  await db.user.destroy({ where: { id: [9861] }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id].filter(Boolean) },
    force: true
  })
})

async function createAR(body) {
  return request(app)
    .post('/accounts-receivable/create')
    .set('Authorization', `Bearer ${admin1Token}`)
    .send({ orderId: order1.id, ...body })
}

describe('N1 AR-create monetary precision', () => {
  test('Case A — valid integer amount is accepted and stored exactly', async () => {
    const res = await createAR({ totalAmount: 100000 })

    expect(res.status).toBe(201)
    expect(Number(res.body.data.totalAmount)).toBe(100000)
    expect(Number(res.body.data.outstandingAmount)).toBe(100000)

    const row = await db.accounts_receivable.findByPk(res.body.data.id)
    expect(Number(row.totalAmount)).toBe(100000)
    expect(Number(row.outstandingAmount)).toBe(100000)

    await db.accounts_receivable.destroy({ where: { id: row.id }, force: true })
  })

  test('Case B — fractional amount is rejected, never silently truncated', async () => {
    const before = await db.accounts_receivable.count({
      where: { orderId: order1.id }
    })

    const res = await createAR({ totalAmount: 100000.5 })

    expect(res.status).toBe(422)

    const after = await db.accounts_receivable.count({
      where: { orderId: order1.id }
    })
    expect(after).toBe(before)
  })

  test('Case C — non-numeric amount is rejected at the schema boundary', async () => {
    // "abc" never reaches the controller: the Zod schema rejects it with
    // 400 via the validate middleware. This pins that malformed input
    // cannot fall through to persistence.
    const before = await db.accounts_receivable.count({
      where: { orderId: order1.id }
    })

    const res = await createAR({ totalAmount: 'abc' })

    expect(res.status).toBe(400)

    const after = await db.accounts_receivable.count({
      where: { orderId: order1.id }
    })
    expect(after).toBe(before)
  })

  test('Case C — empty amount keeps existing required-field behavior', async () => {
    const res = await createAR({ totalAmount: null })

    expect(res.status).toBe(400)
  })
})
