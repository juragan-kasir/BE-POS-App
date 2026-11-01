process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const crypto = require('crypto')
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// E2E audit (2026-10-31): a QR order carried the diner's name as cashierName,
// so receipts and per-cashier figures credited the customer. It now has no
// cashier until staff collect it; the collecting staff member is recorded.

const unique = (p) => `${p}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`

let store = null
let category = null
let product = null
let admin = null
let adminToken = null
const tables = []

const makeTable = async () => {
  const table = await db.table.create({ store: store.id, name: unique('QRC_TABLE') })
  tables.push(table.id)
  return table
}

const as = (method, path) =>
  request(app)[method](path).set('Authorization', `Bearer ${adminToken}`).query({ store: store.id })

beforeAll(async () => {
  store = await db.location.create({ name: unique('QRC_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('QRC_CAT') })
  product = await db.product.create({
    nameProduct: unique('QRC_PRODUCT'),
    category: category.id,
    price: 10000,
    stock: 1000,
    isAvailable: true
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.taxConfig.create({ store: store.id, name: unique('QRC_PPN'), rate: 0, type: 'ppn', status: 'active' })
  admin = await db.user.create({
    userName: unique('qrc_admin'),
    email: `${unique('qrc_admin')}@test.com`,
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

describe('QR order cashier attribution', () => {
  test('a QR order has no cashier until staff collect it, then the collector is recorded', async () => {
    const created = await request(app)
      .post('/order/customer-create')
      .send({
        store: store.id,
        tableId: (await makeTable()).id,
        customerName: 'Tamu Budi',
        items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
        idempotencyKey: unique('qrc')
      })
    expect(created.status).toBe(201)
    const order = await db.order.findByPk(created.body.data.id)
    expect(order.cashierName).toBeNull()
    expect(order.cashierId).toBeNull()
    expect(order.customerName).toBe('Tamu Budi')

    const paid = await as('put', '/order/update-status').send({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      changedByName: 'Kasir Sore'
    })
    expect(paid.status).toBe(200)
    const settled = await db.order.findByPk(order.id)
    expect(settled.cashierId).toBe(admin.id)
    expect(settled.cashierName).toBe('Kasir Sore')
  })

  test('an order that already has a cashier keeps it when collected', async () => {
    const bill = await as('post', '/order/open-bill').send({
      store: store.id,
      tableId: (await makeTable()).id,
      cashierId: admin.id,
      cashierName: 'Kasir Pagi',
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1 }],
      idempotencyKey: unique('qrc-bill')
    })
    expect(bill.status).toBe(201)
    await as('put', '/order/update-status').send({
      id: bill.body.data.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      changedByName: 'Kasir Sore'
    })
    expect((await db.order.findByPk(bill.body.data.id)).cashierName).toBe('Kasir Pagi')
  })
})
