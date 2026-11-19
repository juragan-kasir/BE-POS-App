process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 2 HIGH-4 regression: stockHistory.getByProduct returned all-store
// stock movements for a product because the WHERE clause only filtered by
// productId without checking stock_history.store.
// With the fix, non-super-admin receives only own-store stock movements.

let store1 = null
let store2 = null
let category = null
let product = null
let admin1Token = null
let admin2Token = null
let superToken = null
let hist1 = null
let hist2 = null
let histGlobal = null
let lowStockProduct1 = null
let lowStockProduct2 = null

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({ name: 'HIGH4_STORE_A', status: 'active' }))
  store2 = await db.location.create(await withTestTenant({ name: 'HIGH4_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'HIGH4_CAT', status: 'active' })
  product = await db.product.create({
    nameProduct: 'HIGH4_SHARED_PRODUCT',
    category: category.id,
    price: 1000
  })

  // F21-02 fixtures: one low-stock product per store, assigned via
  // product_store so getLowStockAll's own filtering logic can attribute
  // each to the correct store.
  lowStockProduct1 = await db.product.create({
    nameProduct: 'HIGH4_LOWSTOCK_STORE1',
    category: category.id,
    price: 1000,
    stock: 1,
    minStock: 5,
    status: 'active'
  })
  lowStockProduct2 = await db.product.create({
    nameProduct: 'HIGH4_LOWSTOCK_STORE2',
    category: category.id,
    price: 1000,
    stock: 1,
    minStock: 5,
    status: 'active'
  })

  const suffix = Date.now()
  const user1 = await db.user.create({
    id: 9401,
    userName: `high4_admin_a_${suffix}`,
    roleType: 'admin',
    store: store1.id,
    password: 'x'
  })
  const user2 = await db.user.create({
    id: 9402,
    userName: `high4_admin_b_${suffix}`,
    roleType: 'admin',
    store: store2.id,
    password: 'x'
  })

  // P1-4: central gate denies unknown caller identities; the super token id
  // gets a real row. Assertions below are unchanged.
  await db.user.create({
    id: 9400,
    userName: `high4_super_${suffix}`,
    email: `p14-9400-security-high4-stock-history-${Date.now()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: `high4_super_${suffix}`
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  admin1Token = await signSessionToken(
    { id: user1.id, userName: user1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  admin2Token = await signSessionToken(
    { id: user2.id, userName: user2.userName, roleType: 'admin', store: store2.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 9400, userName: `high4_super_${suffix}`, roleType: 'super_admin' },
    JWT_SECRET
  )

  // Create stock_history entries for product in store1, store2, and null (unassigned)
  hist1 = await db.stock_history.create({
    product: product.id,
    store: store1.id,
    referenceType: 'adjustment',
    quantityBefore: 0,
    quantityChange: 10,
    quantityAfter: 10,
    unit: 'pcs',
    notes: 'Store 1 initial'
  })
  hist2 = await db.stock_history.create({
    product: product.id,
    store: store2.id,
    referenceType: 'adjustment',
    quantityBefore: 0,
    quantityChange: 20,
    quantityAfter: 20,
    unit: 'pcs',
    notes: 'Store 2 secret stock'
  })
  histGlobal = await db.stock_history.create({
    product: product.id,
    store: null,
    referenceType: 'adjustment',
    quantityBefore: 0,
    quantityChange: 5,
    quantityAfter: 5,
    unit: 'pcs',
    notes: 'Unassigned global stock'
  })

  await db.product_store.create({ product: lowStockProduct1.id, store: store1.id })
  await db.product_store.create({ product: lowStockProduct2.id, store: store2.id })
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [9400] }, force: true })
  await db.stock_history.destroy({
    where: { product: product?.id },
    force: true
  })
  await db.product_store.destroy({
    where: { product: [lowStockProduct1?.id, lowStockProduct2?.id] },
    force: true
  })
  await db.product.destroy({
    where: { id: [product?.id, lowStockProduct1?.id, lowStockProduct2?.id] },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: [9401, 9402] }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
})

describe('HIGH-4 stockHistory tenant scoping', () => {
  test('store1 admin getByProduct returns ONLY store1 movements', async () => {
    const res = await request(app)
      .get(`/stock-history/get-by-product/${product.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const ids = res.body.data.map((h) => h.id)
    expect(ids).toContain(hist1.id)
    expect(ids).not.toContain(hist2.id)
    expect(ids).not.toContain(histGlobal.id)
  })

  test('store2 admin getByProduct returns ONLY store2 movements', async () => {
    const res = await request(app)
      .get(`/stock-history/get-by-product/${product.id}`)
      .set('Authorization', `Bearer ${admin2Token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const ids = res.body.data.map((h) => h.id)
    expect(ids).toContain(hist2.id)
    expect(ids).not.toContain(hist1.id)
    expect(ids).not.toContain(histGlobal.id)
  })

  test('super_admin getByProduct returns movements from all stores', async () => {
    const res = await request(app)
      .get(`/stock-history/get-by-product/${product.id}`)
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const ids = res.body.data.map((h) => h.id)
    expect(ids).toContain(hist1.id)
    expect(ids).toContain(hist2.id)
    expect(ids).toContain(histGlobal.id)
  })

  test('store1 admin getAll stock history is scoped to store1', async () => {
    const res = await request(app)
      .get('/stock-history/get-all')
      .query({ product: product.id })
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const ids = res.body.data.map((h) => h.id)
    expect(ids).toContain(hist1.id)
    expect(ids).not.toContain(hist2.id)
  })

  test('store1 admin getAll cannot override store via query param', async () => {
    const res = await request(app)
      .get('/stock-history/get-all')
      .query({ store: store2.id, product: product.id })
      .set('Authorization', `Bearer ${admin1Token}`)

    // validateStoreAccess or controller will block or scope to store1
    if (res.status === 200) {
      const ids = res.body.data.map((h) => h.id)
      expect(ids).not.toContain(hist2.id)
    } else {
      expect(res.status).toBe(403)
    }
  })
})

// F21-02 regression: getLowStockAll read the raw, client-supplied
// req.query.store instead of the middleware-validated req.storeId.
// validateStoreAccess always pins req.storeId to the caller's own store for
// non-super-admin regardless of what was supplied — but the controller's
// own `if (store) {...}` filter only ever looked at req.query.store, so
// simply omitting the store param (the FE's own default behavior) fell
// through to returning every store's low-stock data.
describe('F21-02 stockHistory getLowStockAll tenant scoping', () => {
  test('store1 admin omitting the store query param sees only store1\'s low-stock product', async () => {
    const res = await request(app)
      .get('/stock-history/low-stock-all')
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.items.map((i) => i.id)
    expect(ids).toContain(lowStockProduct1.id)
    expect(ids).not.toContain(lowStockProduct2.id)
  })

  test('store1 admin explicitly requesting store2 cannot see store2\'s low-stock product', async () => {
    const res = await request(app)
      .get('/stock-history/low-stock-all')
      .query({ store: store2.id })
      .set('Authorization', `Bearer ${admin1Token}`)

    if (res.status === 200) {
      const ids = res.body.data.items.map((i) => i.id)
      expect(ids).not.toContain(lowStockProduct2.id)
    } else {
      expect(res.status).toBe(403)
    }
  })

  test('super_admin omitting the store query param still sees low-stock products from every store', async () => {
    const res = await request(app)
      .get('/stock-history/low-stock-all')
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.items.map((i) => i.id)
    expect(ids).toContain(lowStockProduct1.id)
    expect(ids).toContain(lowStockProduct2.id)
  })

  test('super_admin explicitly requesting store1 sees only store1\'s low-stock product', async () => {
    const res = await request(app)
      .get('/stock-history/low-stock-all')
      .query({ store: store1.id })
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.items.map((i) => i.id)
    expect(ids).toContain(lowStockProduct1.id)
    expect(ids).not.toContain(lowStockProduct2.id)
  })
})
