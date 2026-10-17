process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// P1-6a: gross display figures (totalSales in the close snapshot) must
// attribute orders to the REGISTER that collected them, not to the opener.
// A multi-cashier shift where B sells into A's open drawer must count B's
// sales in the drawer totals.

let store = null
let category = null
let product = null
let openerToken = null
let sellerToken = null

const auth = (token) => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  store = await db.location.create({ name: `REGDISP_STORE_${Date.now()}`, status: 'active' })
  category = await db.category.create({ name: `REGDISP_CAT_${Date.now()}` })
  product = await db.product.create({
    nameProduct: `REGDISP_PROD_${Date.now()}`,
    category: category.id,
    price: 20000,
    stock: 1000,
    inventoryMode: 'stocked'
  })
  // DR-14: the outlet row is authoritative — seed it or the sale is refused.
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.user.create({
    id: 7961,
    userName: `regdisp_opener_${Date.now()}`,
    email: `regdisp_opener_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'Opener'
  })
  await db.user.create({
    id: 7962,
    userName: `regdisp_seller_${Date.now()}`,
    email: `regdisp_seller_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'Seller'
  })
  openerToken = await signSessionToken(
    { id: 7961, userName: 'regdisp_opener', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  sellerToken = await signSessionToken(
    { id: 7962, userName: 'regdisp_seller', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  await db.taxConfig.create({
    name: `REGDISP_PPN_${store.id}`,
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  await db.cashRegister.destroy({ where: { store: store.id, status: 'open' }, force: true })
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.stock_history.destroy({ where: { product: product.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store.id }, force: true })
  await db.best_selling.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.user.destroy({ where: { id: [7961, 7962] }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

describe('P1-6a — register display totals attribute by drawer, not opener', () => {
  test("another cashier's cash sale into the open drawer counts in close totals", async () => {
    const openRes = await request(app)
      .post('/cash-register/open')
      .set(auth(openerToken))
      .send({ store: store.id, openingBalance: 0, shift: 1 })
    expect([200, 201]).toContain(openRes.status)
    const registerId = openRes.body.data.id

    // Seller B (second admin, not the opener) sells one unit cash into
    // the drawer.
    const orderRes = await request(app)
      .post('/order/create')
      .set(auth(sellerToken))
      .send({
        store: store.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'Seller',
        idempotencyKey: `regdisp-${Date.now()}`
      })
    expect(orderRes.status).toBe(201)

    const closeRes = await request(app)
      .put(`/cash-register/close/${registerId}`)
      .set(auth(openerToken))
      .send({ store: store.id, closingBalance: 0 })
    expect(closeRes.status).toBe(200)

    // Gross sales must include the other cashier's order (price 20000 +
    // 11% PPN configured above — assert on inclusion, not the exact tax
    // math, which other suites own).
    const gross = closeRes.body.data?.summary?.totalSales
    expect(Number(gross)).toBeGreaterThan(0)
  })
})
