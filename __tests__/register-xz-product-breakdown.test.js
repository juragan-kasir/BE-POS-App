process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BA finding #1 (Waroeng Bakso dummy, 2026-10-17): the X/Z report showed
// aggregates only (totals by tender / expense category) — a shift could
// not be inspected per item. The report now carries `salesByProduct`
// (name, SKU, qty, unit price, line total) for both the live X report,
// the live Z fallback, and the frozen close snapshot; legacy snapshots
// (taken before the field existed) serve [].

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const PRICE_A = 25000
const PRICE_B = 15000
const QTY_A = 2
const QTY_B = 3

let store = null
let category = null
let productA = null
let productB = null
let adminUser = null
let adminToken = null
let skuA = null
let skuB = null

const auth = (token) => ({ Authorization: `Bearer ${token}` })

async function makeCounterOrder() {
  const res = await request(app)
    .post('/order/create')
    .set(auth(adminToken))
    .send(
      withIdempotencyKey({
        store: store.id,
        items: [
          { product: productA.id, quantity: QTY_A },
          { product: productB.id, quantity: QTY_B }
        ],
        paymentMethod: 'cash',
        cashierName: 'B1XZ Cashier',
        idempotencyKey: unique('b1xzcreate')
      })
    )
  if (res.status !== 201) throw new Error('counter setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

const openRegister = () =>
  request(app)
    .post('/cash-register/open')
    .set(auth(adminToken))
    .send({ store: store.id, openingBalance: 0, shift: 1 })

const xReport = () => request(app).get('/cash-register/x-report').set(auth(adminToken))
const zReport = (id) => request(app).get(`/cash-register/z-report/${id}`).set(auth(adminToken))

beforeAll(async () => {
  store = await db.location.create({ name: unique('B1XZ_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('B1XZ_CAT') })
  skuA = unique('SKU_A')
  skuB = unique('SKU_B')
  productA = await db.product.create({
    nameProduct: unique('B1XZ_PRODUCT_A'),
    sku: skuA,
    category: category.id,
    price: PRICE_A,
    stock: 100000
  })
  productB = await db.product.create({
    nameProduct: unique('B1XZ_PRODUCT_B'),
    sku: skuB,
    category: category.id,
    price: PRICE_B,
    stock: 100000
  })
  await db.product_store_stock.create({ product: productA.id, store: store.id, stock: 100000 })
  await db.product_store_stock.create({ product: productB.id, store: store.id, stock: 100000 })
  await db.taxConfig.create({ store: store.id, name: unique('B1XZ_PPN'), rate: 0, type: 'ppn', status: 'active' })

  adminUser = await db.user.create({
    userName: unique('b1xz_admin'),
    email: `${unique('b1xz_admin')}@test.com`,
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
    await db.transaction.destroy({ where: { order: orderIds }, force: true })
    await db.order_item.destroy({ where: { order: orderIds }, force: true })
    await db.order_status.destroy({ where: { order: orderIds }, force: true })
    await db.order.destroy({ where: { id: orderIds }, force: true })
  }
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.best_selling.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.stock_history.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.user.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: [productA?.id, productB?.id].filter(Boolean) }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('BA finding #1 — X/Z product-level breakdown', () => {
  test('X-report carries an empty salesByProduct before any sale', async () => {
    const open = await openRegister()
    expect([200, 201]).toContain(open.status)
    const res = await xReport()
    expect(res.status).toBe(200)
    expect(res.body.data.salesByProduct).toEqual([])
  })

  test('X-report breaks the shift down per product (name, SKU, qty, unit price, line total)', async () => {
    await makeCounterOrder()
    const res = await xReport()
    expect(res.status).toBe(200)
    const rows = res.body.data.salesByProduct
    expect(rows).toHaveLength(2)

    const rowA = rows.find((r) => r.productName === productA.nameProduct)
    expect(rowA).toBeTruthy()
    expect(rowA.sku).toBe(skuA)
    expect(rowA.quantity).toBe(QTY_A)
    expect(rowA.unitPrice).toBe(PRICE_A)
    expect(rowA.totalSales).toBe(PRICE_A * QTY_A)

    const rowB = rows.find((r) => r.productName === productB.nameProduct)
    expect(rowB).toBeTruthy()
    expect(rowB.sku).toBe(skuB)
    expect(rowB.quantity).toBe(QTY_B)
    expect(rowB.unitPrice).toBe(PRICE_B)
    expect(rowB.totalSales).toBe(PRICE_B * QTY_B)

    // The breakdown must reconcile with the aggregate it explains.
    const totalQty = rows.reduce((s, r) => s + r.quantity, 0)
    const totalSales = rows.reduce((s, r) => s + r.totalSales, 0)
    expect(totalQty).toBe(res.body.data.summary.totalQuantity)
    expect(totalSales).toBe(PRICE_A * QTY_A + PRICE_B * QTY_B)
  })

  test('Z-report freezes the same breakdown into the close snapshot', async () => {
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const closed = await request(app)
      .put(`/cash-register/close/${register.id}`)
      .set(auth(adminToken))
      .send({ store: store.id, closingBalance: 0 })
    expect(closed.status).toBe(200)

    const row = await db.cashRegister.findByPk(register.id)
    expect(row.closeSnapshot.salesByProduct).toHaveLength(2)

    const res = await zReport(register.id)
    expect(res.status).toBe(200)
    const rows = res.body.data.salesByProduct
    expect(rows).toHaveLength(2)
    const rowA = rows.find((r) => r.productName === productA.nameProduct)
    expect(rowA).toEqual({
      productName: productA.nameProduct,
      sku: skuA,
      quantity: QTY_A,
      unitPrice: PRICE_A,
      totalSales: PRICE_A * QTY_A
    })
  })

  test('legacy snapshots without salesByProduct serve [] (no crash, no recompute)', async () => {
    const legacy = await db.cashRegister.create({
      store: store.id,
      user: adminUser.id,
      shift: 2,
      openingBalance: 0,
      closingBalance: 0,
      status: 'closed',
      openedAt: new Date(Date.now() - 3600 * 1000),
      closedAt: new Date(),
      closeSnapshot: { gross: {}, payments: [], expenses: [] }
    })
    const res = await zReport(legacy.id)
    expect(res.status).toBe(200)
    expect(res.body.data.salesByProduct).toEqual([])
  })
})
