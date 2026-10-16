process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// PAYMENT P1 — BLOCKER-1 canonical identity regression.
//
// The canonicalizer rejected already-canonical CARD / BANK_TRANSFER /
// E_WALLET, which broke every caller family that passes canonical tender
// values back through normalizePaymentMethod(): void planning, remainder
// settlement falling back to a canonical header value, and sales-return
// approval on canonical-tender orders. Each test below fails pre-fix with
// 422 INVALID_PAYMENT_METHOD and passes post-fix with canonical tender
// preserved end to end. Tender is never reinterpreted, only accepted.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const UNIT_PRICE = 25000
const QTY = 4
const G = UNIT_PRICE * QTY // 100,000

let store = null
let category = null
let product = null
let adminToken = null
let adminUser = null
const createdTableIds = []

const auth = (token) => ({ Authorization: `Bearer ${token}` })

async function makeTable(storeId) {
  const t = await db.table.create({ store: storeId, name: unique('P1I_TABLE') })
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
      customerName: 'P1I QR',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: QTY }],
      idempotencyKey: unique('p1iqr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

const updateStatus = (token, body) =>
  request(app).put('/order/update-status').set(auth(token)).send(body)

const createSplits = (orderId, amounts, token = adminToken) =>
  request(app)
    .post('/split-bill/create')
    .set(auth(token))
    .send({ order: orderId, items: amounts.map((amount) => ({ amount })) })

const paySplit = (splitId, body, token = adminToken) =>
  request(app).put(`/split-bill/pay/${splitId}`).set(auth(token)).send(body)

async function ledgerRows(orderId) {
  return db.transaction.findAll({ where: { order: orderId }, order: [['id', 'ASC']] })
}

async function openRegister() {
  const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
  return register
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('P1I_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('P1I_CAT') })
  product = await db.product.create({
    nameProduct: unique('P1I_PRODUCT'),
    category: category.id,
    price: UNIT_PRICE,
    stock: 10000
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 10000 })
  await db.taxConfig.create({ store: store.id, name: unique('P1I_PPN'), rate: 0, type: 'ppn', status: 'active' })

  adminUser = await db.user.create({
    userName: unique('p1i_admin'),
    email: `${unique('p1i_admin')}@test.com`,
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
    const returns = await db.sales_return.findAll({ where: { order: orderIds }, attributes: ['id'] })
    const returnIds = returns.map((r) => r.id)
    if (returnIds.length) {
      await db.sales_return_item.destroy({ where: { salesReturn: returnIds }, force: true })
      await db.sales_return.destroy({ where: { id: returnIds }, force: true })
    }
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

describe.each([
  ['CARD', 'debit'],
  ['BANK_TRANSFER', 'transfer'],
  ['E_WALLET', 'ewallet']
])('VOID — canonical %s tender refunds in its original tender', (canonical, alias) => {
  test(`void of a ${canonical}-settled order refunds ${canonical} with correct register and actor`, async () => {
    const order = await makeQrOrder()
    const settled = await updateStatus(adminToken, {
      id: order.id, store: store.id, status: 'paid', paymentMethod: alias, referenceNumber: `P1I-SALE-${canonical}`
    })
    expect(settled.status).toBe(200)
    expect((await ledgerRows(order.id))[0].typePayment).toBe(canonical)

    const register = await openRegister()
    const voided = await updateStatus(adminToken, {
      id: order.id, store: store.id, status: 'void', reason: 'P1I void', refundReference: `P1I-VOID-${canonical}`
    })
    expect(voided.status).toBe(200)

    const rows = await ledgerRows(order.id)
    const refunds = rows.filter((r) => Number(r.amount) < 0)
    expect(refunds).toHaveLength(1)
    expect(refunds[0].typePayment).toBe(canonical)
    expect(Number(refunds[0].amount)).toBe(-G)
    expect(Number(refunds[0].cashRegisterId)).toBe(Number(register.id))
    expect(Number(refunds[0].createdBy)).toBe(Number(adminUser.id))

    const C = rows.filter((r) => Number(r.amount) > 0).reduce((s, r) => s + Number(r.amount), 0)
    const R = refunds.reduce((s, r) => s + Math.abs(Number(r.amount)), 0)
    expect(C).toBe(G)
    expect(R).toBe(G)
    const final = await db.order.findByPk(order.id)
    expect(final.status).toBe('void')
    expect(final.paymentStatus).toBe('refunded')
  })
})

describe.each([
  ['CARD', 'CARD'],
  ['BANK_TRANSFER', 'BANK_TRANSFER'],
  ['E_WALLET', 'E_WALLET']
])('REMAINDER — canonical %s first settlement followed by exact remainder', (canonical) => {
  test(`split ${canonical} 30000 then remainder ${canonical} 70000 reaches PAID with exact O`, async () => {
    const order = await makeQrOrder()
    const created = await createSplits(order.id, [30000, 70000])
    expect(created.status).toBe(201)
    const [first] = created.body.data

    const paid = await paySplit(first.id, { paymentMethod: canonical, referenceNumber: `P1I-${canonical}-1` })
    expect(paid.status).toBe(200)

    const remainder = await updateStatus(adminToken, {
      id: order.id, store: store.id, status: 'paid', paymentMethod: canonical, amount: 70000,
      ...(canonical === 'CASH' ? {} : { referenceNumber: `P1I-${canonical}-2` })
    })
    expect(remainder.status).toBe(200)

    const rows = await ledgerRows(order.id)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => [Number(r.amount), r.typePayment])).toEqual([
      [30000, canonical],
      [70000, canonical]
    ])
    const final = await db.order.findByPk(order.id)
    expect(final.status).toBe('paid')
    expect(final.paymentStatus).toBe('paid')
  })
})

describe.each([
  ['CARD', 'debit'],
  ['BANK_TRANSFER', 'transfer'],
  ['E_WALLET', 'ewallet']
])('SALES RETURN — canonical %s tender refunds with register and reference', (canonical, alias) => {
  test(`approve on a ${canonical}-settled order preserves tender, register and reference`, async () => {
    const order = await makeQrOrder()
    expect((await updateStatus(adminToken, {
      id: order.id, store: store.id, status: 'paid', paymentMethod: alias, referenceNumber: `P1I-RETSALE-${canonical}`
    })).status).toBe(200)

    const items = await db.order_item.findAll({ where: { order: order.id } })
    const created = await request(app).post(`/pos/order/${order.id}/return`).set(auth(adminToken)).send({
      items: [{ productId: product.id, orderItemId: items[0].id, qty: 1 }],
      reason: 'P1I return',
      refundMethod: alias,
      idempotencyKey: unique('p1iret')
    })
    expect(created.status).toBe(201)

    const approved = await request(app)
      .patch(`/sales-return/approve/${created.body.data.id}`)
      .set(auth(adminToken))
      .send({ id: created.body.data.id, refundReference: `P1I-REF-${canonical}` })
    expect(approved.status).toBe(200)

    const register = await openRegister()
    const rows = await ledgerRows(order.id)
    const refunds = rows.filter((r) => Number(r.amount) < 0)
    expect(refunds).toHaveLength(1)
    expect(refunds[0].typePayment).toBe(canonical)
    expect(Number(refunds[0].amount)).toBe(-UNIT_PRICE)
    expect(refunds[0].referenceNumber).toBe(`P1I-REF-${canonical}`)
    expect(Number(refunds[0].cashRegisterId)).toBe(Number(register.id))
    expect(Number(refunds[0].createdBy)).toBe(Number(adminUser.id))
  })
})
