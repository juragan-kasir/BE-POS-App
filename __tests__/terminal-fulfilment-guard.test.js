process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BA §35.10 / DR-23 — terminal fulfilment-state bypass guard.
//
// Residual gap: kitchen cascade (PUT /order/update-item-status) blindly
// overwrites Order.status from OrderItem.status with no terminal check and
// no transaction/lock, so a financially-cancelled/voided order can be
// resurrected to pending/preparing/ready/served and re-opened for
// collection. These tests lock the invariant:
//
//   Once Order.status ∈ {cancelled, void}, ordinary kitchen cascade must
//   never move it backward or resurrect it. Terminal wins, cascade no-op,
//   financial state untouched.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const UNIT_PRICE = 25000
const QTY = 1
const G = UNIT_PRICE * QTY

let store = null
let category = null
let product = null
let adminToken = null
let adminUser = null
const createdTableIds = []

const auth = (token) => ({ Authorization: `Bearer ${token}` })

async function makeTable(storeId) {
  const t = await db.table.create({ store: storeId, name: unique('TERM_TABLE') })
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
      customerName: 'TERM QR',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: QTY }],
      idempotencyKey: unique('termqr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function orderItems(orderId) {
  return db.order_item.findAll({ where: { order: orderId }, order: [['id', 'ASC']] })
}

const updateStatus = (token, body) =>
  request(app).put('/order/update-status').set(auth(token)).send(body)

const updateItemStatus = (token, body) =>
  request(app).put('/order/update-item-status').set(auth(token)).send(body)

const createSplits = (orderId, amounts, token = adminToken) =>
  request(app)
    .post('/split-bill/create')
    .set(auth(token))
    .send({ order: orderId, items: amounts.map((amount) => ({ amount })) })

const paySplit = (splitId, token = adminToken, paymentMethod = 'cash') =>
  request(app).put(`/split-bill/pay/${splitId}`).set(auth(token)).send({ paymentMethod })

async function oracle(orderId) {
  const order = await db.order.findByPk(orderId)
  const rows = await db.transaction.findAll({ where: { order: orderId } })
  const Gv = Number(order.totalPrice) || 0
  const C = rows.filter((r) => Number(r.amount) > 0).reduce((s, r) => s + Number(r.amount), 0)
  const R = rows.filter((r) => Number(r.amount) < 0).reduce((s, r) => s + Math.abs(Number(r.amount)), 0)
  const returns = await db.sales_return.findAll({ where: { order: orderId, status: 'approved' } })
  const terminal = ['cancelled', 'void'].includes(order.status)
  const V = terminal ? Gv : Math.min(Gv, returns.reduce((s, r) => s + Number(r.refundAmount || 0), 0))
  const P = Gv - V
  const N = C - R
  const O = P - C + R
  let state
  if (O < 0 || (R > 0 && O > 0) || R > C) state = 'INVALID'
  else if (C === 0 && R === 0) state = Gv === 0 && !terminal ? 'PAID' : 'UNPAID'
  else if (R === 0) state = O > 0 ? 'PARTIALLY_PAID' : 'PAID'
  else state = N === 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
  return { G: Gv, V, P, C, R, N, O, state, order, rows }
}

async function snapshot(orderId) {
  const order = await db.order.findByPk(orderId)
  const txns = await db.transaction.findAll({ where: { order: orderId }, order: [['id', 'ASC']] })
  const splits = await db.split_bill.findAll({
    where: { order: orderId },
    paranoid: false,
    order: [['id', 'ASC']]
  })
  const outbox = await db.accounting_outbox.count({ where: { referenceType: 'order', referenceId: orderId } })
  const journals = await db.journal_entry.count({ where: { referenceId: orderId } }).catch(() => 0)
  const saleHistory = await db.stock_history.count({ where: { referenceId: orderId } }).catch(() => 0)
  return {
    status: order.status,
    paymentStatus: order.paymentStatus,
    txns: txns.map((t) => [t.id, Number(t.amount), t.typePayment]),
    splits: splits.map((s) => [s.id, s.status, Number(s.amount), s.deletedAt ? 'deleted' : 'live']),
    outbox,
    journals,
    saleHistory
  }
}

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: unique('TERM_STORE'), status: 'active' }))
  category = await db.category.create({ name: unique('TERM_CAT') })
  product = await db.product.create({
    nameProduct: unique('TERM_PRODUCT'),
    category: category.id,
    price: UNIT_PRICE,
    stock: 10000
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 10000 })
  await db.taxConfig.create({ store: store.id, name: unique('TERM_PPN'), rate: 0, type: 'ppn', status: 'active' })

  adminUser = await db.user.create({
    userName: unique('term_admin'),
    email: `${unique('term_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )

  const openRes = await request(app)
    .post('/cash-register/open')
    .set(auth(adminToken))
    .send({ store: store.id, openingBalance: 0, shift: 1 })
  if (![200, 201].includes(openRes.status)) throw new Error('register setup failed: ' + JSON.stringify(openRes.body))
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
    await db.order.destroy({ where: { id: orderIds }, force: true })
  }
  await db.cashMovement.destroy({ where: { store: store.id }, force: true }).catch(() => {})
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

describe('T-TERM-01. Cancelled order + kitchen/item status update never resurrects', () => {
  test('cancelled remains cancelled; no fulfilment resurrection; no payment eligibility change', async () => {
    const order = await makeQrOrder()
    const items = await orderItems(order.id)
    expect(items.length).toBeGreaterThan(0)
    const itemId = items[0].id

    const cancel = await updateStatus(adminToken, { id: order.id, store: store.id, status: 'cancelled' })
    expect(cancel.status).toBe(200)
    expect((await db.order.findByPk(order.id)).status).toBe('cancelled')
    const before = await snapshot(order.id)
    const oracleBefore = await oracle(order.id)

    // Ordinary kitchen progression must become a header no-op on terminal orders.
    const kitchen = await updateItemStatus(adminToken, { id: order.id, itemId, itemStatus: 'preparing' })
    expect(kitchen.status).toBe(200)

    const after = await db.order.findByPk(order.id)
    expect(after.status).toBe('cancelled')
    expect(after.paymentStatus).toBe(before.paymentStatus)

    // No payment eligibility change: ledger/split/outbox untouched and the
    // order is still not settleable / not splittable.
    expect(await snapshot(order.id)).toEqual(before)
    expect((await oracle(order.id)).O).toBe(oracleBefore.O)

    const settle = await updateStatus(adminToken, {
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash'
    })
    expect(settle.status).toBe(409)
    expect(await snapshot(order.id)).toEqual(before)

    const split = await createSplits(order.id, [G])
    expect(split.status).toBe(409)
    expect(await snapshot(order.id)).toEqual(before)
  })
})

describe('T-TERM-02. Cancelled order + settlement is deterministically refused', () => {
  test('409 ORDER_NOT_SETTLEABLE (or OUTSTANDING path for terminal), zero ledger/stock/journal/loyalty effect', async () => {
    const order = await makeQrOrder()
    const cancel = await updateStatus(adminToken, { id: order.id, store: store.id, status: 'cancelled' })
    expect(cancel.status).toBe(200)

    const stockRow = () => db.product_store_stock.findOne({ where: { product: product.id, store: store.id } })
    const stockBefore = Number((await stockRow()).stock)
    const journalsBefore = await db.journal_entry.count({ where: { referenceId: order.id } }).catch(() => 0)
    const outboxBefore = await db.accounting_outbox.count({ where: { referenceType: 'order', referenceId: order.id } })
    const before = await snapshot(order.id)

    const res = await updateStatus(adminToken, {
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash'
    })
    expect(res.status).toBe(409)
    expect(await snapshot(order.id)).toEqual(before)
    expect((await oracle(order.id)).C).toBe(0)
    expect(Number((await stockRow()).stock)).toBe(stockBefore)
    expect(await db.journal_entry.count({ where: { referenceId: order.id } }).catch(() => 0)).toBe(journalsBefore)
    expect(await db.accounting_outbox.count({ where: { referenceType: 'order', referenceId: order.id } })).toBe(outboxBefore)
  })
})

describe('T-TERM-03. Cancelled order + split creation is refused', () => {
  test('409 ORDER_NOT_SPLITTABLE, no split created', async () => {
    const order = await makeQrOrder()
    expect((await updateStatus(adminToken, { id: order.id, store: store.id, status: 'cancelled' })).status).toBe(200)
    const splitsBefore = await db.split_bill.count({ where: { order: order.id } })

    const res = await createSplits(order.id, [G])
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ORDER_NOT_SPLITTABLE')
    expect(await db.split_bill.count({ where: { order: order.id } })).toBe(splitsBefore)
    expect((await oracle(order.id)).C).toBe(0)
  })
})

describe('T-TERM-04. Cancelled order + existing pending split + split pay is refused', () => {
  test('409 SPLIT_NOT_PAYABLE, no financial effect', async () => {
    const order = await makeQrOrder()
    const [split] = (await createSplits(order.id, [G])).body.data
    expect((await updateStatus(adminToken, { id: order.id, store: store.id, status: 'cancelled' })).status).toBe(200)

    // Cancel retires the pending split (CANCELLED audit); a stray live row
    // must also stay unpayable on a terminal order.
    const stray = await db.split_bill.create({
      order: order.id,
      splitNumber: unique('TERM_STRAY'),
      amount: G,
      status: 'pending'
    })
    try {
      for (const id of [split.id, stray.id]) {
        const before = await snapshot(order.id)
        const pay = await paySplit(id)
        expect(pay.status).toBe(409)
        expect(pay.body.code).toBe('SPLIT_NOT_PAYABLE')
        expect(await snapshot(order.id)).toEqual(before)
      }
      expect((await oracle(order.id))).toMatchObject({ C: 0, R: 0 })
    } finally {
      await db.split_bill.destroy({ where: { id: stray.id }, force: true })
    }
  })
})

describe('T-TERM-05. Void order + kitchen/item status update never resurrects', () => {
  test('void remains terminal; no fulfilment resurrection; no payment/split eligibility', async () => {
    const order = await makeQrOrder()
    expect(
      (await updateStatus(adminToken, { id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash' })).status
    ).toBe(200)
    expect((await updateStatus(adminToken, { id: order.id, store: store.id, status: 'void', reason: 'TERM void' })).status).toBe(
      200
    )
    expect((await db.order.findByPk(order.id)).status).toBe('void')
    const items = await orderItems(order.id)
    const itemId = items[0].id
    const before = await snapshot(order.id)

    const kitchen = await updateItemStatus(adminToken, { id: order.id, itemId, itemStatus: 'preparing' })
    expect(kitchen.status).toBe(200)

    const after = await db.order.findByPk(order.id)
    expect(after.status).toBe('void')
    expect(after.paymentStatus).toBe('refunded')
    expect(await snapshot(order.id)).toEqual(before)

    // No additional collection through settlement or splits; refund intact.
    const settle = await updateStatus(adminToken, {
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash'
    })
    expect(settle.status).toBe(409)
    const split = await createSplits(order.id, [G])
    expect(split.status).toBe(409)
    expect(await snapshot(order.id)).toEqual(before)
    expect((await oracle(order.id))).toMatchObject({ state: 'REFUNDED' })
  })
})

describe('T-TERM-06. Concurrent terminal transition vs kitchen cascade never resurrects', () => {
  test('cancel then N concurrent kitchen updates still ends cancelled', async () => {
    const order = await makeQrOrder()
    const items = await orderItems(order.id)
    const itemId = items[0].id
    expect((await updateStatus(adminToken, { id: order.id, store: store.id, status: 'cancelled' })).status).toBe(200)

    // True DB-level race (cancel txn vs unlock cascade read-modify-write)
    // has no serialization point by design — the cascade holds no order
    // lock — so a fully deterministic interleaving test would require a
    // new locking model (out of scope). This verifies the next-best
    // guarantee: even under concurrent cascade pressure, terminal wins.
    const results = await Promise.all(
      ['preparing', 'ready', 'served', 'preparing', 'ready'].map((itemStatus) =>
        updateItemStatus(adminToken, { id: order.id, itemId, itemStatus })
      )
    )
    for (const r of results) expect(r.status).toBe(200)
    expect((await db.order.findByPk(order.id)).status).toBe('cancelled')
    expect((await updateStatus(adminToken, { id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash' })).status).toBe(
      409
    )
  })
})

describe('T-TERM-07. Generic status update never resurrects terminal orders (second-path guard)', () => {
  test.each([
    ['cancelled', 'preparing'],
    ['cancelled', 'ready'],
    ['cancelled', 'served'],
    ['cancelled', 'pending'],
    ['cancelled', 'confirmed']
  ])('%s -> %s is refused 409 INVALID_TRANSITION with zero mutation', async (from, to) => {
    const order = await makeQrOrder()
    expect((await updateStatus(adminToken, { id: order.id, store: store.id, status: from })).status).toBe(200)
    const before = await snapshot(order.id)

    const res = await updateStatus(adminToken, { id: order.id, store: store.id, status: to })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INVALID_TRANSITION')
    expect(await snapshot(order.id)).toEqual(before)
    expect((await db.order.findByPk(order.id)).status).toBe(from)
  })

  test.each([
    ['void', 'preparing'],
    ['void', 'ready'],
    ['void', 'served']
  ])('%s -> %s is refused 409 INVALID_TRANSITION with refund intact', async (from, to) => {
    const order = await makeQrOrder()
    expect(
      (await updateStatus(adminToken, { id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash' })).status
    ).toBe(200)
    expect((await updateStatus(adminToken, { id: order.id, store: store.id, status: from, reason: 'TERM-07 void' })).status).toBe(
      200
    )
    const before = await snapshot(order.id)

    const res = await updateStatus(adminToken, { id: order.id, store: store.id, status: to })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INVALID_TRANSITION')
    expect(await snapshot(order.id)).toEqual(before)
    expect((await oracle(order.id))).toMatchObject({ state: 'REFUNDED' })
  })
})
