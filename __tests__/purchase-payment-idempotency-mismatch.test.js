process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-IDEM-1 (purchase payment): same-key retries carrying a different
// amount must not silently replay the winner. Canonical identity = the
// paid amount (the money movement); method/notes/reference-text are not
// part of it.

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let adminToken = null
let supplier = null
let po = null

async function postPayment(body) {
  return request(app)
    .post('/purchase-payment/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: store.id,
      purchaseOrder: po.id,
      supplier: supplier.id,
      paymentMethod: 'cash',
      ...body
    })
}

async function payCount(key) {
  return db.purchase_payment.count({ where: { purchaseOrder: po.id, idempotencyKey: key } })
}

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: `PPIDEM_STORE_${Date.now()}`, status: 'active' }))
  supplier = await db.supplier.create({
    name: `PPIDEM_SUP_${Date.now()}`,
    phone: '0800000003'
  })
  const adminUser = await db.user.create({
    userName: `admin_ppidem_${Date.now()}`,
    email: `admin_ppidem_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  po = await db.purchase_order.create({
    store: store.id,
    supplier: supplier.id,
    orderNumber: `PPIDEM-PO-${Date.now()}`,
    totalAmount: 2000000,
    finalAmount: 2000000,
    status: 'ordered'
  })
})

afterAll(async () => {
  await db.purchase_payment.destroy({ where: { purchaseOrder: po?.id }, force: true })
  const journals = await db.journal_entry.findAll({ where: { store: store?.id } })
  for (const j of journals) {
    await db.journal_entry_line.destroy({ where: { journalEntry: j.id }, force: true })
  }
  await db.journal_entry.destroy({ where: { store: store?.id }, force: true })
  await db.accounting_outbox.destroy({ where: { store: store?.id }, force: true })
  await db.purchase_order.destroy({ where: { id: po?.id }, force: true })
  await db.supplier.destroy({ where: { id: supplier?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F-IDEM-1 purchase-payment payload mismatch', () => {
  test('A — same key + same amount replays without a second payment', async () => {
    const key = unique('ppA')
    const first = await postPayment({ amount: 100000, idempotencyKey: key, reference: unique('ppA-ref') })
    expect(first.status).toBe(201)

    const retry = await postPayment({ amount: 100000, idempotencyKey: key, reference: unique('ppA-ref2') })
    expect(retry.status).toBe(200)
    expect(retry.body?.data?.id).toBe(first.body?.data?.id)
    expect(await payCount(key)).toBe(1)
  })

  test('B — same key + different amount is rejected without a second payment', async () => {
    const key = unique('ppB')
    const first = await postPayment({ amount: 100000, idempotencyKey: key, reference: unique('ppB-ref') })
    expect(first.status).toBe(201)

    const retry = await postPayment({ amount: 150000, idempotencyKey: key, reference: unique('ppB-ref2') })
    expect(retry.status).toBe(409)
    expect(await payCount(key)).toBe(1)
  })

  test('C — concurrent same-key requests create exactly one payment', async () => {
    const key = unique('ppC')
    const payload = { amount: 50000, idempotencyKey: key, reference: unique('ppC-ref') }
    const [r1, r2] = await Promise.all([postPayment(payload), postPayment(payload)])
    expect([r1.status, r2.status].sort()).toEqual([200, 201])
    expect(await payCount(key)).toBe(1)
  })

  test('D — different keys create independent payments', async () => {
    const r1 = await postPayment({ amount: 20000, idempotencyKey: unique('ppD1'), reference: unique('ppD-r1') })
    const r2 = await postPayment({ amount: 20000, idempotencyKey: unique('ppD2'), reference: unique('ppD-r2') })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r2.body?.data?.id).not.toBe(r1.body?.data?.id)
  })

  test('F — overpay failure does not poison the key; valid retry succeeds', async () => {
    const key = unique('ppF')
    const bad = await postPayment({ amount: 999999999, idempotencyKey: key, reference: unique('ppF-bad') })
    expect(bad.status).toBe(400)

    const good = await postPayment({ amount: 30000, idempotencyKey: key, reference: unique('ppF-good') })
    expect(good.status).toBe(201)
    expect(await payCount(key)).toBe(1)
  })
})
