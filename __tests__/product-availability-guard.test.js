process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// P1-7: products that are inactive or flagged unavailable must be refused
// at order intake (counter and QR alike) — not just hidden from the menu.

let store = null
let table = null
let category = null
let adminToken = null

const auth = (token) => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  store = await db.location.create({ name: `PAV_STORE_${Date.now()}`, status: 'active' })
  table = await db.table.create({ store: store.id, name: 'PAV_TABLE' })
  category = await db.category.create({ name: `PAV_CAT_${Date.now()}` })
  await db.user.create({
    id: 7971,
    userName: `pav_admin_${Date.now()}`,
    email: `pav_admin_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'PAV Admin'
  })
  adminToken = await signSessionToken(
    { id: 7971, userName: 'pav_admin', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  await db.taxConfig.create({
    name: `PAV_PPN_${store.id}`,
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  await db.cashRegister.destroy({ where: { store: store.id, status: 'open' }, force: true })
  await db.cashRegister.create({
    store: store.id,
    user: 7971,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store.id }, force: true })
  await db.best_selling.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { category: category.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.table.destroy({ where: { id: table?.id }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.user.destroy({ where: { id: [7971] }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

const makeProduct = (overrides = {}) =>
  db.product.create({
    nameProduct: `PAV_PROD_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    category: category.id,
    price: 20000,
    stock: 100,
    inventoryMode: 'stocked',
    ...overrides
  })

const seedOutlet = (product) =>
  db.product_store_stock.create({ product: product.id, store: store.id, stock: 100 })

describe('P1-7 — unavailable products are refused at intake', () => {
  test('counter rejects an inactive product', async () => {
    const product = await makeProduct({ status: 'inactive' })
    await seedOutlet(product)
    const res = await request(app)
      .post('/order/create')
      .set(auth(adminToken))
      .send({
        store: store.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'PAV',
        idempotencyKey: `pav-${Date.now()}-1`
      })
    expect(res.status).toBe(400)
    expect(res.body.code || res.body.error || '').toMatch(/NOT_AVAILABLE/i)
  })

  test('counter rejects a product flagged unavailable today', async () => {
    const product = await makeProduct({ isAvailableHariIni: false })
    await seedOutlet(product)
    const res = await request(app)
      .post('/order/create')
      .set(auth(adminToken))
      .send({
        store: store.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'PAV',
        idempotencyKey: `pav-${Date.now()}-2`
      })
    expect(res.status).toBe(400)
  })

  test('QR customer-create rejects an inactive product', async () => {
    const product = await makeProduct({ status: 'inactive' })
    await seedOutlet(product)
    await db.table.update({ status: 'available' }, { where: { id: table.id } })
    const res = await request(app)
      .post('/order/customer-create')
      .send({
        tableId: table.id,
        store: store.id,
        items: [{ productId: product.id, quantity: 1 }]
      })
    expect(res.status).toBe(400)
  })

  test('an active, available product still sells', async () => {
    const product = await makeProduct({ status: 'active', isAvailable: true, isAvailableHariIni: true })
    await seedOutlet(product)
    const res = await request(app)
      .post('/order/create')
      .set(auth(adminToken))
      .send({
        store: store.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'PAV',
        idempotencyKey: `pav-${Date.now()}-4`
      })
    expect(res.status).toBe(201)
  })
})
