process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const crypto = require('crypto')
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// PGA-06 (product-grade audit 2026-11-02) / ADR-03: the diner's payment
// intent from BISA ("saya bayar tunai") is stored on the order, and a staff
// `paid` with no method inherited it — CASH booked with cashReceived = the
// amount due, cash recorded without anyone counting it. Settlement now needs
// the method staff chose in the request.

const unique = (p) => `${p}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`

let store = null
let category = null
let product = null
let admin = null
let adminToken = null
const tables = []

const makeTable = async () => {
  const table = await db.table.create({ store: store.id, name: unique('PGA06_TABLE') })
  tables.push(table.id)
  return table
}

const as = (method, path) =>
  request(app)[method](path).set('Authorization', `Bearer ${adminToken}`).query({ store: store.id })

beforeAll(async () => {
  store = await db.location.create({ name: unique('PGA06_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('PGA06_CAT') })
  product = await db.product.create({
    nameProduct: unique('PGA06_PRODUCT'),
    category: category.id,
    price: 10000,
    stock: 1000,
    isAvailable: true
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.taxConfig.create({ store: store.id, name: unique('PGA06_PPN'), rate: 0, type: 'ppn', status: 'active' })
  admin = await db.user.create({
    userName: unique('pga06_admin'),
    email: `${unique('pga06_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'Kasir Sore'
  })
  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  const open = await as('post', '/cash-register/open').send({ store: store.id, openingBalance: 0, shift: 1 })
  if (![200, 201].includes(open.status)) throw new Error('register: ' + JSON.stringify(open.body))
})

afterAll(async () => {
  const orders = (await db.order.findAll({ where: { store: store?.id }, paranoid: false })).map((o) => o.id)
  await db.accounting_outbox.destroy({ where: { store: store?.id }, force: true })
  await db.transaction.destroy({ where: { order: orders }, force: true })
  await db.order_status.destroy({ where: { order: orders }, force: true })
  await db.order_item.destroy({ where: { order: orders }, force: true })
  await db.order.destroy({ where: { id: orders }, force: true })
  const registers = (await db.cashRegister.findAll({ where: { store: store?.id } })).map((r) => r.id)
  await db.cashMovement.destroy({ where: { cashRegisterId: registers }, force: true })
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { store: store?.id }, force: true })
  await db.stock_history.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.table.destroy({ where: { id: tables }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

const createQr = async (intent) => {
  const created = await request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: (await makeTable()).id,
      customerName: 'Tamu ' + intent,
      paymentMethod: intent,
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
      idempotencyKey: unique('pga06')
    })
  expect(created.status).toBe(201)
  return db.order.findByPk(created.body.data.id)
}
const ledger = (orderId) => db.transaction.findAll({ where: { order: orderId }, raw: true })

describe('PGA-06 — the diner intent is never the settlement tender', () => {
  test.each(['cash', 'e-wallet', 'qris'])(
    'intent "%s": staff `paid` with no method is refused (422 PAYMENT_METHOD_REQUIRED), nothing booked',
    async (intent) => {
      const order = await createQr(intent)
      const res = await as('put', '/order/update-status').send({ id: order.id, store: store.id, status: 'paid' })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('PAYMENT_METHOD_REQUIRED')
      expect(await ledger(order.id)).toHaveLength(0)
      const after = await db.order.findByPk(order.id)
      expect(after.paymentStatus).not.toBe('paid')
    }
  )

  test('staff choosing cash with the counted amount settles it with that amount and change', async () => {
    const order = await createQr('cash')
    const due = Number(order.totalPrice)
    const res = await as('put', '/order/update-status').send({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      cashAmount: due + 5000,
      changeAmount: 5000
    })

    expect(res.status).toBe(200)
    const rows = await ledger(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].typePayment).toBe('CASH')
    expect(Number(rows[0].cashReceived)).toBe(due + 5000)
    expect(Number(rows[0].changeGiven)).toBe(5000)
  })

  test('staff may settle with a different method than the diner declared', async () => {
    const order = await createQr('cash')
    const res = await as('put', '/order/update-status').send({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'qris',
      referenceNumber: unique('REF')
    })

    expect(res.status).toBe(200)
    const rows = await ledger(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].typePayment).not.toBe('CASH')
  })
})
