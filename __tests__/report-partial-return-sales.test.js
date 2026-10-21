process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// A partially returned sale stays a sale. The legacy paymentStatus 'partial'
// (PARTIALLY_REFUNDED after an approved return) used to drop the whole order
// from the register X/Z sales totals and the daily report, while its payment
// and refund rows still counted — so sales no longer reconciled with the
// ledger. An unfinished split bill (also 'partial') must stay excluded.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const PRICE = 20000

let store = null
let category = null
let product = null
let admin = null
let token = null
let registerId = null
const tableIds = []
const as = () => ({ Authorization: `Bearer ${token}` })

async function cashSale(qty) {
  const res = await request(app)
    .post('/order/create')
    .set(as())
    .send({
      store: store.id,
      items: [{ product: product.id, quantity: qty }],
      paymentMethod: 'cash',
      cashAmount: PRICE * qty,
      changeAmount: 0,
      idempotencyKey: unique('prs')
    })
  if (res.status !== 201) throw new Error('sale failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function approvedReturn(orderId, qty) {
  const created = await request(app)
    .post(`/pos/order/${orderId}/return`)
    .set(as())
    .send({ items: [{ productId: product.id, qty }], reason: 'partial return', idempotencyKey: unique('prsret') })
  if (![200, 201].includes(created.status)) throw new Error('return failed: ' + JSON.stringify(created.body))
  const approved = await request(app)
    .patch(`/sales-return/approve/${created.body.data.id}`)
    .set(as())
    .send({ id: created.body.data.id })
  if (approved.status !== 200) throw new Error('approve failed: ' + JSON.stringify(approved.body))
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('PRS_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('PRS_CAT') })
  product = await db.product.create({ nameProduct: unique('PRS_PRODUCT'), category: category.id, price: PRICE, stock: 1000 })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.taxConfig.create({ store: store.id, name: unique('PRS_PPN'), rate: 0, type: 'ppn', status: 'active' })
  admin = await db.user.create({
    userName: unique('prs_admin'),
    email: `${unique('prs_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken({ id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id }, JWT_SECRET)
  const open = await request(app)
    .post('/cash-register/open')
    .set(as())
    .send({ store: store.id, openingBalance: 0 })
  if (![200, 201].includes(open.status)) throw new Error('register setup failed: ' + JSON.stringify(open.body))
  registerId = open.body.data.id
})

afterAll(async () => {
  const orderIds = (await db.order.findAll({ where: { store: store.id }, attributes: ['id'] })).map((o) => o.id)
  const returnIds = (await db.sales_return.findAll({ where: { store: store.id }, attributes: ['id'] })).map((r) => r.id)
  // Refund rows reference their sales return and split bill: ledger first.
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.sales_return_item.destroy({ where: { salesReturn: returnIds }, force: true })
  await db.sales_return.destroy({ where: { id: returnIds }, force: true })
  await db.split_bill.destroy({ where: { order: orderIds }, force: true })
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
  await db.user.destroy({ where: { id: admin?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

test('a partially returned sale stays in X/Z and daily sales; an unfinished split bill does not', async () => {
  const kept = await cashSale(1)
  const returned = await cashSale(2)
  await approvedReturn(returned.id, 1)
  expect((await db.order.findByPk(returned.id)).paymentStatus).toBe('partial')

  // Unfinished split bill: also 'partial', but not a completed sale.
  const table = await db.table.create({ store: store.id, name: unique('PRS_TABLE') })
  tableIds.push(table.id)
  const qr = await request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 2 }],
      idempotencyKey: unique('prsqr')
    })
  expect(qr.status).toBe(201)
  const split = await request(app)
    .post('/split-bill/create')
    .set(as())
    .send({ order: qr.body.data.id, items: [{ amount: PRICE }, { amount: PRICE }], idempotencyKey: unique('prssplit') })
  expect(split.status).toBe(201)
  const splitIds = split.body.data.map((s) => s.id)
  const paidOne = await request(app)
    .put(`/split-bill/pay/${splitIds[0]}`)
    .set(as())
    .send({ paymentMethod: 'cash', cashAmount: PRICE, changeAmount: 0 })
  expect(paidOne.status).toBe(200)
  expect((await db.order.findByPk(qr.body.data.id)).paymentStatus).toBe('partial')

  const z = await request(app).get(`/cash-register/z-report/${registerId}`).set(as())
  expect(z.status).toBe(200)
  const summary = z.body.data.summary
  // kept (1 × PRICE) + returned (2 × PRICE gross); the split bill is excluded.
  expect(summary.totalTransactions).toBe(2)
  expect(summary.totalSales).toBe(3 * PRICE)
  // Gross sales minus refunds equals the collected cash for completed sales:
  // 3 × PRICE − 1 × PRICE refunded = 2 × PRICE (+ PRICE from the open split).
  expect(summary.totalSales - summary.refundsTotal).toBe(2 * PRICE)

  const x = await request(app).get(`/cash-register/x-report?store=${store.id}`).set(as())
  expect(x.status).toBe(200)
  expect(x.body.data.summary.totalSales).toBe(3 * PRICE)

  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10)
  const daily = await request(app).get(`/report/daily?store=${store.id}&startDate=${today}&endDate=${today}`).set(as())
  expect(daily.status).toBe(200)
  const row = daily.body.data[0]
  expect(Number(row.totalTransaksi)).toBe(2)
  expect(Number(row.totalPenjualanBersih)).toBe(2 * PRICE)
  expect(kept.id).toBeDefined()
})
