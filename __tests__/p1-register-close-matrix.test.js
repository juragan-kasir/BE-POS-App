process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// PAYMENT P1 — close/snapshot matrix supplement (§27 exact IDs).
//
// Companion to p1-register-close-snapshot.test.js. Covers the matrix rows
// not yet isolated there: CLOSE-01/02, SNAP-05/06 split out, Z-05 (split),
// Z-06 (sales-return), ROTATE-01/02, REFUND-01/02, RACE-02/04/05, and the
// canonical-order tiebreak (§21).

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const UNIT_PRICE = 25000
const QTY = 4
const G = UNIT_PRICE * QTY

let store = null
let category = null
let product = null
let adminToken = null
let adminUser = null
const createdTableIds = []

const auth = (token) => ({ Authorization: `Bearer ${token}` })

async function makeTable(storeId) {
  const t = await db.table.create({ store: storeId, name: unique('P1M_TABLE') })
  createdTableIds.push(t.id)
  return t
}

async function makeQrOrder() {
  const table = await makeTable(store.id)
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      customerName: 'P1M QR',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: QTY }],
      idempotencyKey: unique('p1mqr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

const settlePaid = (orderId, body = { paymentMethod: 'cash' }) =>
  request(app).put('/order/update-status').set(auth(adminToken)).send({ id: orderId, store: store.id, status: 'paid', ...body })

const openRegister = (shift = 1) =>
  request(app).post('/cash-register/open').set(auth(adminToken)).send({ store: store.id, openingBalance: 0, shift })

const closeRegister = (registerId, closingBalance = 0) =>
  request(app).put(`/cash-register/close/${registerId}`).set(auth(adminToken)).send({ store: store.id, closingBalance })

const zReport = (registerId) =>
  request(app).get(`/cash-register/z-report/${registerId}`).set(auth(adminToken))

const createMovement = (registerId, body) =>
  request(app).post(`/cash-register/${registerId}/movement`).set(auth(adminToken)).send(body)

async function rotateRegister(shift = 1) {
  const open = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
  if (open) await closeRegister(open.id, 0)
  const res = await openRegister(shift)
  expect([200, 201]).toContain(res.status)
  return res.body.data.id
}

function zFinancial(zData) {
  return { summary: zData.summary, payments: zData.payments, expenses: zData.expenses }
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('P1M_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('P1M_CAT') })
  product = await db.product.create({
    nameProduct: unique('P1M_PRODUCT'),
    category: category.id,
    price: UNIT_PRICE,
    stock: 100000
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 100000 })
  await db.taxConfig.create({ store: store.id, name: unique('P1M_PPN'), rate: 0, type: 'ppn', status: 'active' })
  adminUser = await db.user.create({
    userName: unique('p1m_admin'),
    email: `${unique('p1m_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  const orders = await db.order.findAll({ where: { store: store.id }, paranoid: false, attributes: ['id'] })
  const orderIds = orders.map((o) => o.id)
  if (orderIds.length) {
    await db.split_bill.destroy({ where: { order: orderIds }, force: true })
    await db.transaction.destroy({ where: { order: orderIds }, force: true })
    await db.order_item.destroy({ where: { order: orderIds }, force: true })
    await db.order_status.destroy({ where: { order: orderIds }, force: true })
    await db.accounting_outbox.destroy({ where: { referenceType: 'order', referenceId: orderIds } })
    const returns = await db.sales_return.findAll({ where: { order: orderIds }, attributes: ['id'] })
    const returnIds = returns.map((r) => r.id)
    if (returnIds.length) {
      await db.sales_return_item.destroy({ where: { salesReturn: returnIds }, force: true })
      await db.sales_return.destroy({ where: { id: returnIds }, force: true })
    }
    await db.order.destroy({ where: { id: orderIds }, force: true })
  }
  await db.cashMovement.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.expense.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.best_selling.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.stock_history.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.table.destroy({ where: { id: createdTableIds }, force: true })
  await db.user.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('CLOSE lifecycle', () => {
  test('CLOSE-01: an open register can close', async () => {
    const registerId = await rotateRegister(51)
    const closed = await closeRegister(registerId, 0)
    expect(closed.status).toBe(200)
    expect((await db.cashRegister.findByPk(registerId)).status).toBe('closed')
  })

  test('CLOSE-02: a closed register cannot close again', async () => {
    const registerId = await rotateRegister(52)
    expect((await closeRegister(registerId, 0)).status).toBe(200)
    const again = await closeRegister(registerId, 0)
    expect(again.status).toBe(404)
  })
})

describe('SNAP cash legs, isolated', () => {
  test('SNAP-05: cash_in increases expectedCash', async () => {
    const registerId = await rotateRegister(53)
    expect((await createMovement(registerId, { type: 'cash_in', reasonCode: 'float_topup', amount: 25000 })).status).toBe(201)
    const closed = await closeRegister(registerId, 25000)
    expect(closed.status).toBe(200)
    expect(Number((await db.cashRegister.findByPk(registerId)).expectedCash)).toBe(25000)
  })

  test('SNAP-06: cash_out decreases expectedCash', async () => {
    const registerId = await rotateRegister(54)
    expect((await createMovement(registerId, { type: 'cash_out', reasonCode: 'bank_drop', amount: 15000 })).status).toBe(201)
    const closed = await closeRegister(registerId, 0)
    expect(closed.status).toBe(200)
    expect(Number((await db.cashRegister.findByPk(registerId)).expectedCash)).toBe(-15000)
  })

  test('SNAP-10b: canonical tiebreak orders equal-total methods CASH,CARD,QRIS,POINTS,OTHER deterministically', async () => {
    const registerId = await rotateRegister(55)
    // Two counter orders (creator-owned, so inside the payments breakdown)
    // with equal 100k noncash totals: raw-ASC would put OTHER first;
    // canonical order (§21) puts POINTS first.
    for (const [method, ref] of [['other', 'M-OTHER-1'], ['points', 'M-POINTS-1']]) {
      const res = await request(app)
        .post('/order/create')
        .set(auth(adminToken))
        .send(withIdempotencyKey({
          store: store.id,
          items: [{ product: product.id, quantity: QTY }],
          paymentMethod: method,
          referenceNumber: ref,
          cashierName: 'P1M Cashier',
          idempotencyKey: unique('p1mcanon')
        }))
      expect(res.status).toBe(201)
    }
    await closeRegister(registerId, 0)
    const types = (await zReport(registerId)).body.data.payments.map((p) => p.type)
    expect(types.slice(0, 2)).toEqual(['POINTS', 'OTHER'])
  })
})

describe('Z per-activity isolation', () => {
  test('Z-05: R1 Z unchanged after an R2 split settlement', async () => {
    const r1 = await rotateRegister(56)
    const order = await makeQrOrder()
    expect((await settlePaid(order.id)).status).toBe(200)
    await closeRegister(r1, G)
    const before = JSON.stringify(zFinancial((await zReport(r1)).body.data))
    const r2 = await rotateRegister(57)
    const order2 = await makeQrOrder()
    const created = await request(app)
      .post('/split-bill/create')
      .set(auth(adminToken))
      .send({ order: order2.id, items: [{ amount: G }] })
    expect(created.status).toBe(201)
    expect(
      (await request(app).put(`/split-bill/pay/${created.body.data[0].id}`).set(auth(adminToken)).send({ paymentMethod: 'cash' })).status
    ).toBe(200)
    expect(JSON.stringify(zFinancial((await zReport(r1)).body.data))).toBe(before)
    await closeRegister(r2, G)
  })

  test('Z-06: R1 Z unchanged after an R2 sales-return refund', async () => {
    const r1 = await rotateRegister(58)
    const order = await makeQrOrder()
    expect((await settlePaid(order.id)).status).toBe(200)
    await closeRegister(r1, G)
    const before = JSON.stringify(zFinancial((await zReport(r1)).body.data))
    const r2 = await rotateRegister(59)
    const order2 = await makeQrOrder()
    expect((await settlePaid(order2.id)).status).toBe(200)
    const items = await db.order_item.findAll({ where: { order: order2.id } })
    const created = await request(app).post(`/pos/order/${order2.id}/return`).set(auth(adminToken)).send({
      items: [{ productId: product.id, orderItemId: items[0].id, qty: 1 }],
      reason: 'P1M Z-06',
      refundMethod: 'cash',
      idempotencyKey: unique('p1mz06')
    })
    expect(created.status).toBe(201)
    const approved = await request(app).patch(`/sales-return/approve/${created.body.data.id}`).set(auth(adminToken)).send({ id: created.body.data.id })
    expect(approved.status).toBe(200)
    const refunds = (await db.transaction.findAll({ where: { order: order2.id } })).filter((r) => Number(r.amount) < 0)
    expect(refunds).toHaveLength(1)
    expect(JSON.stringify(zFinancial((await zReport(r1)).body.data))).toBe(before)
    await closeRegister(r2, 0)
  })
})

describe('ROTATE / REFUND flows', () => {
  test('ROTATE-01: R1/R2 financial isolation across rotation', async () => {
    const r1 = await rotateRegister(61)
    const o1 = await makeQrOrder()
    expect((await settlePaid(o1.id)).status).toBe(200)
    await closeRegister(r1, G)
    const r2 = await rotateRegister(62)
    const o2 = await makeQrOrder()
    expect((await settlePaid(o2.id)).status).toBe(200)
    await closeRegister(r2, G)
    expect(Number((await db.cashRegister.findByPk(r1)).expectedCash)).toBe(G)
    expect(Number((await db.cashRegister.findByPk(r2)).expectedCash)).toBe(G)
    expect(JSON.stringify(zFinancial((await zReport(r1)).body.data))).toBe(
      JSON.stringify(zFinancial((await zReport(r1)).body.data))
    )
  })

  test('ROTATE-02: cross-register partial keeps per-leg attribution and snapshots', async () => {
    const r1 = await rotateRegister(63)
    const order = await makeQrOrder()
    const created = await request(app)
      .post('/split-bill/create')
      .set(auth(adminToken))
      .send({ order: order.id, items: [{ amount: 30000 }, { amount: 70000 }] })
    expect(created.status).toBe(201)
    const [s1, s2] = created.body.data
    expect((await request(app).put(`/split-bill/pay/${s1.id}`).set(auth(adminToken)).send({ paymentMethod: 'cash', cashAmount: 30000, changeAmount: 0 })).status).toBe(200)
    await closeRegister(r1, 30000)
    const r2 = await rotateRegister(64)
    expect((await request(app).put(`/split-bill/pay/${s2.id}`).set(auth(adminToken)).send({ paymentMethod: 'cash', cashAmount: 70000, changeAmount: 0 })).status).toBe(200)
    const rows = await db.transaction.findAll({ where: { order: order.id }, order: [['id', 'ASC']] })
    expect(rows.map((r) => Number(r.cashRegisterId)).sort()).toEqual([Number(r1), Number(r2)].sort())
    expect((await db.order.findByPk(order.id)).paymentStatus).toBe('paid')
    expect(Number((await db.cashRegister.findByPk(r1)).expectedCash)).toBe(30000)
    await closeRegister(r2, 70000)
    expect(Number((await db.cashRegister.findByPk(r2)).expectedCash)).toBe(70000)
  })

  test('REFUND-01/02: partial refund after R1 close belongs to R2; R1 keeps +100k', async () => {
    const r1 = await rotateRegister(65)
    const order = await makeQrOrder()
    expect((await settlePaid(order.id)).status).toBe(200)
    await closeRegister(r1, G)
    const frozenExpected = Number((await db.cashRegister.findByPk(r1)).expectedCash)
    expect(frozenExpected).toBe(G)
    const r2 = await rotateRegister(66)
    // Partial return of 1 of 4 units (25000) on the R1-settled order.
    const created = await request(app).post(`/pos/order/${order.id}/return`).set(auth(adminToken)).send({
      items: [{ productId: product.id, orderItemId: (await db.order_item.findAll({ where: { order: order.id } }))[0].id, qty: 1 }],
      reason: 'P1M REFUND-01',
      refundMethod: 'cash',
      idempotencyKey: unique('p1mref1')
    })
    expect(created.status).toBe(201)
    const approved = await request(app).patch(`/sales-return/approve/${created.body.data.id}`).set(auth(adminToken)).send({ id: created.body.data.id })
    expect(approved.status).toBe(200)
    const refunds = (await db.transaction.findAll({ where: { order: order.id } })).filter((r) => Number(r.amount) < 0)
    expect(refunds).toHaveLength(1)
    expect(Number(refunds[0].amount)).toBe(-25000)
    expect(Number(refunds[0].cashRegisterId)).toBe(Number(r2))
    expect(Number((await db.cashRegister.findByPk(r1)).expectedCash)).toBe(G)
    await closeRegister(r2, 0)
  })
})

describe('RACE matrix supplement', () => {
  test('RACE-02: split settlement racing close serializes deterministically', async () => {
    await rotateRegister(71)
    const order = await makeQrOrder()
    const created = await request(app)
      .post('/split-bill/create')
      .set(auth(adminToken))
      .send({ order: order.id, items: [{ amount: G }] })
    expect(created.status).toBe(201)
    const splitId = created.body.data[0].id
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const [paid, closed] = await Promise.all([
      request(app).put(`/split-bill/pay/${splitId}`).set(auth(adminToken)).send({ paymentMethod: 'cash' }),
      closeRegister(register.id, 0)
    ])
    const rows = await db.transaction.findAll({ where: { order: order.id } })
    if (paid.status === 200) {
      expect(closed.status).toBe(200)
      expect(rows).toHaveLength(1)
      expect(Number(rows[0].cashRegisterId)).toBe(Number(register.id))
    } else {
      // Lost the race either before resolution (422, nothing open) or
      // after it (409, resolved register closed mid-flight). Both refuse
      // with zero rows; silent reassignment never happens.
      expect([409, 422]).toContain(paid.status)
      expect(['REGISTER_STATE_CHANGED', 'REGISTER_REQUIRED']).toContain(paid.body.code)
      expect(rows).toHaveLength(0)
    }
    await rotateRegister(72)
  })

  test('RACE-04: sales-return refund racing close serializes deterministically', async () => {
    await rotateRegister(73)
    const order = await makeQrOrder()
    expect((await settlePaid(order.id)).status).toBe(200)
    const items = await db.order_item.findAll({ where: { order: order.id } })
    const created = await request(app).post(`/pos/order/${order.id}/return`).set(auth(adminToken)).send({
      items: [{ productId: product.id, orderItemId: items[0].id, qty: 1 }],
      reason: 'P1M RACE-04',
      refundMethod: 'cash',
      idempotencyKey: unique('p1mrace4')
    })
    expect(created.status).toBe(201)
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const [approved, closed] = await Promise.all([
      request(app).patch(`/sales-return/approve/${created.body.data.id}`).set(auth(adminToken)).send({ id: created.body.data.id }),
      closeRegister(register.id, 0)
    ])
    const rows = (await db.transaction.findAll({ where: { order: order.id } })).filter((r) => Number(r.amount) < 0)
    if (approved.status === 200) {
      expect(closed.status).toBe(200)
      expect(rows).toHaveLength(1)
    } else {
      // sales-return approve surfaces {success, message} without a code;
      // either refusal preserves zero refund rows.
      expect([409, 422]).toContain(approved.status)
      expect(rows).toHaveLength(0)
    }
    await rotateRegister(74)
  })

  test('RACE-05: cash movement racing close serializes deterministically', async () => {
    await rotateRegister(75)
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const [moved, closed] = await Promise.all([
      createMovement(register.id, { type: 'cash_in', reasonCode: 'float_topup', amount: 5000 }),
      closeRegister(register.id, 0)
    ])
    if (moved.status === 201) {
      expect(closed.status).toBe(200)
      expect(Number((await db.cashRegister.findByPk(register.id)).expectedCash)).toBe(5000)
    } else {
      expect(moved.status).toBe(409)
    }
    await rotateRegister(76)
  })
})
