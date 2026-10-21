process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// DR-23 §J (BA §35.10) interim capability mapping:
//   kasir → cashier baseline (payment.collect) + split.manage,
//           order.cancel (N = 0), refund.request; no void, no approval
//   user  → staff: no sales or settlement rights by default
// Denials are audited (DR-20).
// DR-23 §C/§G: a full sales return ends REFUNDED, never 'unpaid'.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const PRICE = 20000

let store = null
let category = null
let product = null
const tokens = {}
const userIds = []
const tableIds = []

async function makeUser(roleType) {
  const u = await db.user.create({
    userName: unique(`cap_${roleType}`),
    email: `${unique(`cap_${roleType}`)}@test.com`,
    roleType,
    userType: roleType === 'admin' ? 'admin' : 'user',
    store: store.id,
    status: 'active'
  })
  userIds.push(u.id)
  tokens[roleType] = await signSessionToken(
    { id: u.id, userName: u.userName, roleType, store: store.id },
    JWT_SECRET
  )
}

const as = (role) => ({ Authorization: `Bearer ${tokens[role]}` })

async function counterSale(role, qty = 1) {
  return request(app)
    .post('/order/create')
    .set(as(role))
    .send(withIdempotencyKey({
      store: store.id,
      items: [{ product: product.id, quantity: qty }],
      paymentMethod: 'cash',
      cashierName: 'Cap Cashier',
      idempotencyKey: unique('cap')
    }))
}

async function qrOrder(qty = 2) {
  const table = await db.table.create({ store: store.id, name: unique('CAP_TABLE') })
  tableIds.push(table.id)
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      customerName: unique('Cap Guest'),
      items: [{ productId: product.id, productName: product.nameProduct, quantity: qty }],
      idempotencyKey: unique('capqr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

const updateStatus = (role, order, body) =>
  request(app)
    .put('/order/update-status')
    .set(as(role))
    .send({ id: order.id, store: store.id, ...body })

async function deniedAudits(entity, capability) {
  const rows = await db.auditLog.findAll({ where: { entity, store: store.id } })
  return rows.filter((r) => r.newValues?.result === 'DENIED' && r.newValues?.capability === capability)
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('CAP_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('CAP_CAT') })
  product = await db.product.create({
    nameProduct: unique('CAP_PRODUCT'),
    category: category.id,
    price: PRICE,
    stock: 1000
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.taxConfig.create({ store: store.id, name: unique('CAP_PPN'), rate: 0, type: 'ppn', status: 'active' })
  for (const role of ['admin', 'kasir', 'user']) await makeUser(role)
  const openRes = await request(app)
    .post('/cash-register/open')
    .set(as('admin'))
    .send({ store: store.id, openingBalance: 100000, shift: 1 })
  if (![200, 201].includes(openRes.status)) {
    throw new Error('register setup failed: ' + JSON.stringify(openRes.body))
  }
})

afterAll(async () => {
  const orderIds = (await db.order.findAll({ where: { store: store.id }, attributes: ['id'] })).map((o) => o.id)
  const returnIds = (await db.sales_return.findAll({ where: { store: store.id }, attributes: ['id'] })).map((r) => r.id)
  await db.sales_return_item.destroy({ where: { salesReturn: returnIds }, force: true })
  await db.sales_return.destroy({ where: { id: returnIds }, force: true })
  await db.split_bill.destroy({ where: { order: orderIds }, force: true })
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.table.destroy({ where: { id: tableIds }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: userIds }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('DR-23 §J — staff hold no sales or settlement rights', () => {
  test('staff counter sale is refused, writes nothing, and the denial is audited', async () => {
    const before = await db.order.count({ where: { store: store.id } })

    const res = await counterSale('user')

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN')
    expect(await db.order.count({ where: { store: store.id } })).toBe(before)
    expect((await deniedAudits('order', 'payment.collect')).length).toBeGreaterThan(0)
  })

  test('staff cannot settle an order; it stays unpaid with no ledger row', async () => {
    const order = await qrOrder()

    const res = await updateStatus('user', order, {
      status: 'paid', paymentMethod: 'cash', cashAmount: order.totalPrice, changeAmount: 0
    })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN')
    const after = await db.order.findByPk(order.id)
    expect(after.paymentStatus).toBe('unpaid')
    expect(await db.transaction.count({ where: { order: order.id } })).toBe(0)
  })

  test('staff cannot cancel an order', async () => {
    const order = await qrOrder()

    const res = await updateStatus('user', order, { status: 'cancelled' })

    expect(res.status).toBe(403)
    expect((await db.order.findByPk(order.id)).status).toBe('pending')
  })

  test('staff may still move fulfilment (preserved)', async () => {
    const order = await qrOrder()

    const res = await updateStatus('user', order, { status: 'confirmed' })

    expect(res.status).toBe(200)
    expect((await db.order.findByPk(order.id)).status).toBe('confirmed')
  })

  test('staff cannot create a split', async () => {
    const order = await qrOrder()

    const res = await request(app)
      .post('/split-bill/create')
      .set(as('user'))
      .send({ order: order.id, items: [{ amount: order.totalPrice / 2 }, { amount: order.totalPrice / 2 }] })

    expect(res.status).toBe(403)
    expect(await db.split_bill.count({ where: { order: order.id } })).toBe(0)
  })
})

describe('DR-23 §J — kasir default grants', () => {
  test('kasir creates, merges, cancels and pays splits', async () => {
    const order = await qrOrder(2)
    const half = order.totalPrice / 2

    const created = await request(app)
      .post('/split-bill/create')
      .set(as('kasir'))
      .send({ order: order.id, items: [{ amount: half / 2 }, { amount: half / 2 }, { amount: half }], idempotencyKey: unique('capsplit') })
    expect(created.status).toBe(201)

    const pending = await db.split_bill.findAll({ where: { order: order.id }, order: [['id', 'ASC']] })
    expect(pending).toHaveLength(3)

    const merged = await request(app)
      .post('/split-bill/merge')
      .set(as('kasir'))
      .send({ order: order.id, splitIds: [pending[0].id, pending[1].id] })
    expect(merged.status).toBe(201)

    const cancelled = await request(app)
      .delete(`/split-bill/cancel/${merged.body.data.id}`)
      .set(as('kasir'))
    expect(cancelled.status).toBe(200)

    const paid = await request(app)
      .put(`/split-bill/pay/${pending[2].id}`)
      .set(as('kasir'))
      .send({ paymentMethod: 'cash', cashAmount: half, changeAmount: 0 })
    expect(paid.status).toBe(200)
    expect((await db.split_bill.findByPk(pending[2].id)).status).toBe('paid')
  })

  test('kasir requests a return but cannot approve it', async () => {
    const sale = await counterSale('kasir')
    expect(sale.status).toBe(201)

    const requested = await request(app)
      .post(`/pos/order/${sale.body.data.id}/return`)
      .set(as('kasir'))
      .send({ items: [{ productId: product.id, qty: 1 }], reason: 'kasir request', idempotencyKey: unique('capret') })
    expect([200, 201]).toContain(requested.status)

    const approve = await request(app)
      .patch(`/sales-return/approve/${requested.body.data.id}`)
      .set(as('kasir'))
    expect(approve.status).toBe(403)
    expect((await db.sales_return.findByPk(requested.body.data.id)).status).toBe('pending')
    expect((await deniedAudits('sales_return', 'refund.approve')).length).toBeGreaterThan(0)
  })

  test('kasir still cannot void (elevated, preserved)', async () => {
    const sale = await counterSale('kasir')

    const res = await updateStatus('kasir', sale.body.data, { status: 'void', reason: 'try' })

    expect(res.status).toBe(403)
    expect((await db.order.findByPk(sale.body.data.id)).status).not.toBe('void')
  })
})

describe('DR-23 §C/§G — payment state after an approved return', () => {
  async function returnAndApprove(orderId, qty) {
    const created = await request(app)
      .post(`/pos/order/${orderId}/return`)
      .set(as('admin'))
      .send({ items: [{ productId: product.id, qty }], reason: 'state test', idempotencyKey: unique('capret') })
    if (![200, 201].includes(created.status)) throw new Error('return failed: ' + JSON.stringify(created.body))
    const approve = await request(app)
      .patch(`/sales-return/approve/${created.body.data.id}`)
      .set(as('admin'))
    expect(approve.status).toBe(200)
  }

  test('a full return ends refunded, never unpaid', async () => {
    const sale = await counterSale('admin', 2)
    expect(sale.status).toBe(201)

    await returnAndApprove(sale.body.data.id, 2)

    expect((await db.order.findByPk(sale.body.data.id)).paymentStatus).toBe('refunded')
  })

  test('a partial return is partially refunded (legacy "partial")', async () => {
    const sale = await counterSale('admin', 2)

    await returnAndApprove(sale.body.data.id, 1)

    expect((await db.order.findByPk(sale.body.data.id)).paymentStatus).toBe('partial')
  })

  // FE services/sales-return.js: the id travels only in the URL; approve
  // sends { refundReference } or no body, reject never sends a body.
  test('approve and reject accept the FE request shape (id only in the URL)', async () => {
    const requestReturn = async (orderId) => {
      const created = await request(app)
        .post(`/pos/order/${orderId}/return`)
        .set(as('admin'))
        .send({ items: [{ productId: product.id, qty: 1 }], reason: 'fe shape', idempotencyKey: unique('capret') })
      expect([200, 201]).toContain(created.status)
      return created.body.data.id
    }

    const toReject = await requestReturn((await counterSale('admin', 1)).body.data.id)
    const rejected = await request(app).patch(`/sales-return/reject/${toReject}`).set(as('admin'))
    expect(rejected.status).toBe(200)
    expect((await db.sales_return.findByPk(toReject)).status).toBe('rejected')

    const toApprove = await requestReturn((await counterSale('admin', 1)).body.data.id)
    const approved = await request(app)
      .patch(`/sales-return/approve/${toApprove}`)
      .set(as('admin'))
      .send({ refundReference: 'FE-REF-1' })
    expect(approved.status).toBe(200)
    expect((await db.sales_return.findByPk(toApprove)).status).toBe('approved')
  })

  test('a fully returned order cannot be settled again', async () => {
    const sale = await counterSale('admin', 1)
    await returnAndApprove(sale.body.data.id, 1)

    const res = await updateStatus('admin', sale.body.data, {
      status: 'paid', paymentMethod: 'cash', cashAmount: PRICE, changeAmount: 0
    })

    expect(res.status).toBe(409)
  })
})
