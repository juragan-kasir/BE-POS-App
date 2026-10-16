process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 13/14 (C11): the Table association (order.belongsTo(table, {as:
// 'table'})) exists and is already correctly included by getOrderById, but
// three other order-reading paths never included it: getOrdersByStore
// (GET /order/get-orders), getKitchenOrders (GET /order/kitchen), and
// fetchFullOrder (the internal helper that shapes createOrder's own
// response). Each showed only the raw numeric tableId, never the table's
// actual name.

let location = null
let category = null
let product = null
let table = null
let cashierToken = null
let dineInOrder = null
let takeAwayOrder = null

beforeAll(async () => {
  location = await db.location.create({ name: 'C11_STORE', status: 'active' })
  category = await db.category.create({ name: 'C11_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'C11_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100
  })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 100 })
  table = await db.table.create({ store: location.id, name: 'VIP 2' })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 8801,
    userName: 'c11_cashier',
    email: 'p14-8801-order-table-association@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: location.id,
    status: 'active',
    fullName: 'c11_cashier'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  cashierToken = await signSessionToken(
    { id: 8801, userName: 'c11_cashier', roleType: 'kasir', store: location.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these association assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'C11_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: location.id, user: 8801, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.user.destroy({ where: { id: [8801] }, force: true })
  await db.taxConfig.destroy({ where: { store: location?.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.best_selling.destroy({ where: { productId: product?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.table.destroy({ where: { id: table?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('order Table association (C11)', () => {
  test('createOrder response (fetchFullOrder) includes the table name for a dine-in order', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'C11 Cashier',
        tableId: table.id
      }))

    expect(res.status).toBe(201)
    dineInOrder = res.body.data
    expect(res.body.data.table).toBeTruthy()
    expect(res.body.data.table.name).toBe('VIP 2')
  })

  test('createOrder response does not crash and has no table for a take-away order', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'C11 Cashier'
      }))

    expect(res.status).toBe(201)
    takeAwayOrder = res.body.data
    expect(res.body.data.table == null || res.body.data.table === undefined).toBe(true)
  })

  test('getOrdersByStore includes the table name, not just the raw tableId', async () => {
    const res = await request(app)
      .get('/order/get-orders')
      .query({ store: location.id })
      .set('Authorization', `Bearer ${cashierToken}`)

    expect(res.status).toBe(200)
    const found = res.body.data.find((o) => o.id === dineInOrder.id)
    expect(found).toBeTruthy()
    expect(found.table).toBeTruthy()
    expect(found.table.name).toBe('VIP 2')
  })

  test('getOrdersByStore does not crash for an order with no table', async () => {
    const res = await request(app)
      .get('/order/get-orders')
      .query({ store: location.id })
      .set('Authorization', `Bearer ${cashierToken}`)

    expect(res.status).toBe(200)
    const found = res.body.data.find((o) => o.id === takeAwayOrder.id)
    expect(found).toBeTruthy()
    expect(found.table == null || found.table === undefined).toBe(true)
  })

  test('getKitchenOrders includes the table name, not just the raw tableId', async () => {
    const res = await request(app)
      .get('/order/kitchen')
      .set('Authorization', `Bearer ${cashierToken}`)

    expect(res.status).toBe(200)
    const found = res.body.data.find((o) => o.id === dineInOrder.id)
    expect(found).toBeTruthy()
    expect(found.table).toBeTruthy()
    expect(found.table.name).toBe('VIP 2')
  })
})
