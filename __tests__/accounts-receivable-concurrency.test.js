process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location
let orderSeq
let adminToken

async function makeAR(store, total) {
  const order = await db.order.create({
    orderNumber: `AR-RACE-${orderSeq++}`,
    store,
    status: 'pending'
  })
  const ar = await db.accounts_receivable.create({
    store,
    orderId: order.id,
    invoiceNo: `INV-RACE-${order.id}`,
    totalAmount: total,
    paidAmount: 0,
    outstandingAmount: total,
    status: 'UNPAID'
  })
  return { order, ar }
}

const pay = (id, body) =>
  request(app)
    .post(`/accounts-receivable/${id}/pay`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send(body)

describe('F-01 accounts_receivable.recordPayment — concurrent double-apply / lost update', () => {
  beforeAll(async () => {
    location = await db.location.create(await withTestTenant({ name: 'AR_RACE_STORE', status: 'active' }))
    orderSeq = 900000
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 8805,
    userName: 'ar_race_admin',
    email: 'p14-8805-accounts-receivable-concurrency@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'ar_race_admin'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
    adminToken = await signSessionToken(
      { id: 8805, userName: 'ar_race_admin', roleType: 'admin', store: location.id },
      JWT_SECRET
    )
  })

  afterAll(async () => {
  await db.user.destroy({ where: { id: [8805] }, force: true })
    await db.ar_payment.destroy({ where: {}, force: true })
    await db.accounts_receivable.destroy({ where: {}, force: true })
    await db.order.destroy({ where: { store: location.id }, force: true })
    await db.location.destroy({ where: { id: location.id }, force: true })
  })

  test('sequential control: two 600 payments on a 1000 AR — first 201, second 400, AR exact', async () => {
    const { ar } = await makeAR(location.id, 1000)
    const first = await pay(ar.id, { amount: 600 })
    const second = await pay(ar.id, { amount: 600 })
    expect(first.status).toBe(201)
    expect(second.status).toBe(400)

    const fresh = await db.accounts_receivable.findByPk(ar.id)
    expect(Number(fresh.paidAmount)).toBe(600)
    expect(Number(fresh.outstandingAmount)).toBe(400)
    expect(fresh.status).toBe('PARTIAL')

    const rows = await db.ar_payment.findAll({ where: { arId: ar.id } })
    expect(rows).toHaveLength(1)
  })

  test('two CONCURRENT 600 payments on a 1000 AR — exactly one 201, one 400, one payment row', async () => {
    for (let i = 0; i < 15; i += 1) {
      const { ar } = await makeAR(location.id, 1000)
      const results = await Promise.all([
        pay(ar.id, { amount: 600 }),
        pay(ar.id, { amount: 600 })
      ])
      const statuses = results.map((r) => r.status)

      const fresh = await db.accounts_receivable.findByPk(ar.id)
      const rows = await db.ar_payment.findAll({ where: { arId: ar.id } })

      expect(statuses.filter((s) => s === 201)).toHaveLength(1)
      expect(statuses.filter((s) => s === 400)).toHaveLength(1)
      expect(rows).toHaveLength(1)
      expect(Number(fresh.paidAmount)).toBe(600)
      expect(Number(fresh.outstandingAmount)).toBe(400)
      expect(fresh.status).toBe('PARTIAL')
    }
  }, 120000)

  test('two CONCURRENT 500 payments on a 1000 AR — money conserved: paid == sum == total, PAID, zero outstanding', async () => {
    for (let i = 0; i < 15; i += 1) {
      const { ar } = await makeAR(location.id, 1000)
      await Promise.all([
        pay(ar.id, { amount: 500 }),
        pay(ar.id, { amount: 500 })
      ])

      const fresh = await db.accounts_receivable.findByPk(ar.id)
      const paymentRows = await db.ar_payment.findAll({ where: { arId: ar.id } })
      const totalPaid = paymentRows.reduce((s, p) => s + Number(p.amount), 0)

      // Lost-update symptom: two rows each computed from a stale 0 balance,
      // so paymentRows sum to 1000 but the AR row only shows 500 paid.
      expect(Number(fresh.paidAmount)).toBe(1000)
      expect(Number(fresh.outstandingAmount)).toBe(0)
      expect(fresh.status).toBe('PAID')
      expect(totalPaid).toBe(1000)
    }
  }, 120000)

  test('concurrent identical request (same reference) is idempotent — exactly one payment row, applied once', async () => {
    for (let i = 0; i < 10; i += 1) {
      const { ar } = await makeAR(location.id, 1000)
      const results = await Promise.all([
        pay(ar.id, { amount: 300, reference: 'REF-IDEMP-123' }),
        pay(ar.id, { amount: 300, reference: 'REF-IDEMP-123' })
      ])
      const statuses = results.map((r) => r.status).sort()

      const fresh = await db.accounts_receivable.findByPk(ar.id)
      const paymentRows = await db.ar_payment.findAll({
        where: { arId: ar.id, reference: 'REF-IDEMP-123' }
      })

      expect(statuses[0]).toBeLessThan(400) // one success (201 or idempotent 200)
      expect(statuses).toContain(200) // the retry must be treated as already-done
      expect(paymentRows).toHaveLength(1)
      expect(Number(fresh.paidAmount)).toBe(300)
      expect(Number(fresh.outstandingAmount)).toBe(700)
    }
  }, 90000)
})