process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

let storeA, storeB, category, productA, productB
let bundleActiveA, bundleInactiveA, bundleActiveB, bundleUnassigned, bundleFutureA

describe('F-1 GET /product-bundle/customer-active — public customer bundle listing', () => {
  beforeAll(async () => {
    storeA = await db.location.create(await withTestTenant({ name: 'BUNDLE_F1_STORE_A', status: 'active' }))
    storeB = await db.location.create(await withTestTenant({ name: 'BUNDLE_F1_STORE_B', status: 'active' }))
    category = await db.category.create({ name: 'BUNDLE_F1_CATEGORY' })
    productA = await db.product.create({
      nameProduct: 'BUNDLE_F1_PRODUCT_A',
      category: category.id,
      price: 10000,
      stock: 50
    })
    productB = await db.product.create({
      nameProduct: 'BUNDLE_F1_PRODUCT_B',
      category: category.id,
      price: 15000,
      stock: 50
    })

    bundleActiveA = await db.product_bundle.create({
      store: [storeA.id],
      name: 'BUNDLE_F1_ACTIVE_A',
      sku: `F1-ACT-A-${Date.now()}`,
      bundlePrice: 25000,
      originalPrice: 30000,
      isAvailable: true,
      status: 'active'
    })
    await db.product_bundle_item.create({
      bundleId: bundleActiveA.id,
      product: productA.id,
      quantity: 1,
      unitPrice: 10000,
      isOptional: false
    })

    bundleInactiveA = await db.product_bundle.create({
      store: [storeA.id],
      name: 'BUNDLE_F1_INACTIVE_A',
      sku: `F1-INACT-A-${Date.now()}`,
      bundlePrice: 20000,
      isAvailable: true,
      status: 'inactive'
    })

    bundleActiveB = await db.product_bundle.create({
      store: [storeB.id],
      name: 'BUNDLE_F1_ACTIVE_B',
      sku: `F1-ACT-B-${Date.now()}`,
      bundlePrice: 22000,
      isAvailable: true,
      status: 'active'
    })
    await db.product_bundle_item.create({
      bundleId: bundleActiveB.id,
      product: productB.id,
      quantity: 1,
      unitPrice: 15000,
      isOptional: false
    })

    // Unassigned (store: null) bundle — per isBundleOrderableAtStore's own
    // semantics (order.js), a null-store bundle is NOT orderable anywhere,
    // so it must NOT appear in either store's customer listing.
    bundleUnassigned = await db.product_bundle.create({
      store: null,
      name: 'BUNDLE_F1_UNASSIGNED',
      sku: `F1-UNASSIGNED-${Date.now()}`,
      bundlePrice: 18000,
      isAvailable: true,
      status: 'active'
    })

    // Active + assigned to store A, but validFrom is in the future — must
    // be excluded from the customer listing (matches order.js's
    // isBundleWithinValidityPeriod contract for what is actually orderable).
    bundleFutureA = await db.product_bundle.create({
      store: [storeA.id],
      name: 'BUNDLE_F1_FUTURE_A',
      sku: `F1-FUTURE-A-${Date.now()}`,
      bundlePrice: 21000,
      isAvailable: true,
      status: 'active',
      validFrom: new Date(Date.now() + 24 * 60 * 60 * 1000)
    })
  })

  afterAll(async () => {
    const bundleIds = [
      bundleActiveA?.id,
      bundleInactiveA?.id,
      bundleActiveB?.id,
      bundleUnassigned?.id,
      bundleFutureA?.id
    ].filter(Boolean)
    await db.product_bundle_item.destroy({ where: { bundleId: bundleIds }, force: true })
    await db.product_bundle.destroy({ where: { id: bundleIds }, force: true })
    await db.product.destroy({ where: { id: [productA?.id, productB?.id] }, force: true })
    await db.category.destroy({ where: { id: category?.id }, force: true })
    await db.location.destroy({ where: { id: [storeA?.id, storeB?.id] }, force: true })
  })

  test('TEST 1 — anonymous customer (no JWT) receives 200 with active store-A bundles', async () => {
    const res = await request(app)
      .get('/product-bundle/customer-active')
      .query({ store: storeA.id })

    expect(res.status).toBe(200)
    const names = (res.body?.data?.items || []).map((b) => b.name)
    expect(names).toContain('BUNDLE_F1_ACTIVE_A')
  })

  test('TEST 2 — missing store is rejected with 400', async () => {
    const res = await request(app).get('/product-bundle/customer-active')
    expect(res.status).toBe(400)
  })

  test('TEST 3 — invalid (non-numeric) store is rejected with 400, no data leaked', async () => {
    const res = await request(app)
      .get('/product-bundle/customer-active')
      .query({ store: 'not-a-number' })

    expect(res.status).toBe(400)
  })

  test('TEST 3b — nonexistent numeric store returns 200 with an empty list (no leak, no error)', async () => {
    const res = await request(app)
      .get('/product-bundle/customer-active')
      .query({ store: 999999999 })

    expect(res.status).toBe(200)
    expect(res.body?.data?.items || []).toHaveLength(0)
  })

  test('TEST 4 — Store A request returns ONLY Store A bundles', async () => {
    const res = await request(app)
      .get('/product-bundle/customer-active')
      .query({ store: storeA.id })

    expect(res.status).toBe(200)
    const names = res.body.data.items.map((b) => b.name);
    expect(names).toContain('BUNDLE_F1_ACTIVE_A')
    expect(names).not.toContain('BUNDLE_F1_ACTIVE_B')
  })

  test('TEST 5 — Store B request returns ONLY Store B bundles', async () => {
    const res = await request(app)
      .get('/product-bundle/customer-active')
      .query({ store: storeB.id })

    expect(res.status).toBe(200)
    const names = res.body.data.items.map((b) => b.name)
    expect(names).toContain('BUNDLE_F1_ACTIVE_B')
    expect(names).not.toContain('BUNDLE_F1_ACTIVE_A')
  })

  test('TEST 6 — cross-store enumeration: Store B response never combines Store A + Store B datasets', async () => {
    const res = await request(app)
      .get('/product-bundle/customer-active')
      .query({ store: storeB.id })

    expect(res.status).toBe(200)
    expect(res.body.data.items).toHaveLength(1)
    expect(res.body.data.items[0].name).toBe('BUNDLE_F1_ACTIVE_B')
  })

  test('TEST 6b — an unassigned (store:null) bundle never appears for any store', async () => {
    const resA = await request(app)
      .get('/product-bundle/customer-active')
      .query({ store: storeA.id })
    const resB = await request(app)
      .get('/product-bundle/customer-active')
      .query({ store: storeB.id })

    const namesA = resA.body.data.items.map((b) => b.name)
    const namesB = resB.body.data.items.map((b) => b.name)
    expect(namesA).not.toContain('BUNDLE_F1_UNASSIGNED')
    expect(namesB).not.toContain('BUNDLE_F1_UNASSIGNED')
  })

  test('TEST 7 — inactive bundle is excluded', async () => {
    const res = await request(app)
      .get('/product-bundle/customer-active')
      .query({ store: storeA.id })

    const names = res.body.data.items.map((b) => b.name)
    expect(names).not.toContain('BUNDLE_F1_INACTIVE_A')
  })

  test('TEST 7b — a not-yet-valid (future validFrom) bundle is excluded', async () => {
    const res = await request(app)
      .get('/product-bundle/customer-active')
      .query({ store: storeA.id })

    const names = res.body.data.items.map((b) => b.name)
    expect(names).not.toContain('BUNDLE_F1_FUTURE_A')
  })

  test('TEST 8 — customer response exposes only customer-safe fields (no createdBy/modifiedBy)', async () => {
    const res = await request(app)
      .get('/product-bundle/customer-active')
      .query({ store: storeA.id })

    const bundle = res.body.data.items.find((b) => b.name === 'BUNDLE_F1_ACTIVE_A')
    expect(bundle).toBeDefined()
    expect(bundle).not.toHaveProperty('createdBy')
    expect(bundle).not.toHaveProperty('modifiedBy')
    expect(bundle.items[0]).not.toHaveProperty('createdBy')
    expect(bundle.items[0]).not.toHaveProperty('modifiedBy')
    // customer-facing fields the FE actually consumes must be present
    expect(bundle).toHaveProperty('bundlePrice')
    expect(bundle).toHaveProperty('items')
    expect(bundle.items[0].productData).not.toHaveProperty('costPrice')
  })

  test('TEST 9 — existing admin GET /product-bundle/get-all remains protected (401 without JWT)', async () => {
    const res = await request(app).get('/product-bundle/get-all')
    expect(res.status).toBe(401)
  })
})
