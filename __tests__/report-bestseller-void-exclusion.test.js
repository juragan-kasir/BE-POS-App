process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// TDD RED: GET /report/best-seller revenue counts order items from orders
// with paymentStatus='paid' without excluding status IN
// ('cancelled','void'), while the sibling export (reportDefs/bestSeller)
// and every neighboring revenue query exclude them. A legacy-style voided
// order that still reads paymentStatus='paid' therefore inflates the
// controller's product revenue and totalRevenue.
const SUFFIX = Date.now()

let store = null
let category = null
let productValid = null
let productVoided = null
let token = null

beforeAll(async () => {
  store = await db.location.create({ name: `BSVF_STORE_${SUFFIX}`, status: 'active' })
  category = await db.category.create({ name: `BSVF_CAT_${SUFFIX}` })
  productValid = await db.product.create({
    nameProduct: `BSVF_VALID_${SUFFIX}`,
    category: category.id,
    price: 50000,
    stock: 100
  })
  productVoided = await db.product.create({
    nameProduct: `BSVF_VOIDED_${SUFFIX}`,
    category: category.id,
    price: 30000,
    stock: 100
  })
  await db.user.create({
    id: 98031,
    userName: `bsvf_admin_${SUFFIX}`,
    email: `p14-98031-bsvf-${SUFFIX}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: `bsvf_admin_${SUFFIX}`
  })
  token = await signSessionToken(
    { id: 98031, userName: `bsvf_admin_${SUFFIX}`, roleType: 'admin', store: store.id },
    JWT_SECRET
  )

  // Valid paid sale (product A, revenue 50000).
  const validOrder = await db.order.create({
    orderNumber: `BSVF-VALID-${SUFFIX}`,
    store: store.id,
    status: 'paid',
    paymentStatus: 'paid',
    subTotal: 50000,
    totalQuantity: 1,
    totalPrice: 50000,
    source: 'pos'
  })
  await db.order_item.create({
    order: validOrder.id,
    product: productValid.id,
    productName: productValid.nameProduct,
    quantity: 1,
    price: 50000,
    totalPrice: 50000,
    status: 'served'
  })

  // Legacy-style voided order that still reads paymentStatus='paid'
  // (product B, revenue 30000) — must be excluded like the export does.
  const voidedOrder = await db.order.create({
    orderNumber: `BSVF-VOIDED-${SUFFIX}`,
    store: store.id,
    status: 'void',
    paymentStatus: 'paid',
    subTotal: 30000,
    totalQuantity: 1,
    totalPrice: 30000,
    source: 'pos'
  })
  await db.order_item.create({
    order: voidedOrder.id,
    product: productVoided.id,
    productName: productVoided.nameProduct,
    quantity: 1,
    price: 30000,
    totalPrice: 30000,
    status: 'served'
  })

  // best_selling counter rows (sold source is untouched by this fix).
  await db.best_selling.create({
    store: store.id,
    productId: productValid.id,
    nameProduct: productValid.nameProduct,
    totalSelling: 2
  })
  await db.best_selling.create({
    store: store.id,
    productId: productVoided.id,
    nameProduct: productVoided.nameProduct,
    totalSelling: 1
  })
})

afterAll(async () => {
  await db.order_item.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { store: store?.id }, force: true })
  await db.user.destroy({ where: { id: [98031] }, force: true })
  await db.product.destroy({ where: { id: [productValid?.id, productVoided?.id].filter(Boolean) }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('best-seller revenue excludes cancelled/voided orders', () => {
  test('voided-but-paid legacy order contributes no revenue or totalRevenue', async () => {
    const res = await request(app)
      .get('/report/best-seller')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const { bestSellers, summary } = res.body.data
    const byId = Object.fromEntries(bestSellers.map((p) => [Number(p.id), p]))
    // Valid paid sale stays included.
    expect(byId[Number(productValid.id)]?.revenue).toBe(50000)
    // Legacy voided row is excluded, matching the export definition.
    expect(byId[Number(productVoided.id)]?.revenue ?? 0).toBe(0)
    expect(summary.totalRevenue).toBe(50000)
  })

  test('sold source and response shape are unchanged', async () => {
    const res = await request(app)
      .get('/report/best-seller')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const { bestSellers, summary } = res.body.data
    const byId = Object.fromEntries(bestSellers.map((p) => [Number(p.id), p]))
    expect(byId[Number(productValid.id)]?.sold).toBe(2)
    expect(byId[Number(productVoided.id)]?.sold).toBe(1)
    expect(summary.totalUnitsSold).toBe(3)
    expect(typeof summary.activeProducts).toBe('number')
    for (const p of bestSellers) {
      expect(Object.keys(p).sort()).toEqual(['id', 'image', 'name', 'revenue', 'sold'])
    }
  })
})
