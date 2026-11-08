'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Tenant sweep stage 2 (2026-11-08): body/query-id read leaks. Tenant A's
// owner (store-bound super_admin) and admin must not read tenant B's rows by
// naming B's ids, and list endpoints must stay inside the caller's roster.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const unique = (p) => `${p}_${RUN}_${Math.floor(Math.random() * 1e6)}`
const inDays = (n) =>
  new Date(Date.now() + 86400000 * n).toISOString().slice(0, 10)

const tenants = []
const users = []
let storeA
let storeB
let category
let productA
let productB
let supplierB
let batchA
let batchB
let poA
let poB
const tokens = {}

const get = (who, url) =>
  request(app).get(url).set('Authorization', `Bearer ${tokens[who]}`)

beforeAll(async () => {
  const stores = []
  for (const tag of ['A', 'B']) {
    const t = await db.tenant.create({
      code: unique(`SR${tag}`).toUpperCase().slice(0, 30),
      name: unique(`SR${tag}`)
    })
    tenants.push(t)
    stores.push(
      await db.location.create({
        name: unique(`SR_STORE_${tag}`),
        status: 'active',
        tenantId: t.id
      })
    )
  }
  ;[storeA, storeB] = stores
  category = await db.category.create({ name: unique('SR_CAT') })
  const product = async (store, tag) => {
    const p = await db.product.create({
      nameProduct: unique(`SR_PROD_${tag}`),
      category: category.id,
      price: 10000,
      costPrice: 6000,
      stock: 10,
      status: 'active'
    })
    await db.product_store.create({ product: p.id, store: store.id })
    await db.product_store_stock.create({ product: p.id, store: store.id, stock: 10 })
    return p
  }
  productA = await product(storeA, 'A')
  productB = await product(storeB, 'B')
  supplierB = await db.supplier.create({
    name: unique('SR_SUP_B'),
    status: 'active',
    store: [storeB.id]
  })
  const batch = (store, p) =>
    db.product_batch.create({
      store: store.id,
      product: p.id,
      batchCode: unique('SR_BATCH'),
      qty: 5,
      expiryDate: inDays(10),
      status: 'active'
    })
  batchA = await batch(storeA, productA)
  batchB = await batch(storeB, productB)
  const po = (store) =>
    db.purchase_order.create({
      orderNumber: unique('SR_PO'),
      store: store.id,
      status: 'draft',
      orderDate: new Date()
    })
  poA = await po(storeA)
  poB = await po(storeB)

  const owner = await db.user.create({
    userName: unique('sr_owner'),
    email: `${unique('sr_owner')}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active',
    store: storeA.id
  })
  await db.tenantMembership.create({
    userId: owner.id,
    tenantId: tenants[0].id,
    role: 'tenant_admin',
    status: 'ACTIVE'
  })
  const admin = await db.user.create({
    userName: unique('sr_admin'),
    email: `${unique('sr_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    status: 'active',
    store: storeA.id
  })
  users.push(owner, admin)
  for (const [who, u] of [
    ['owner', owner],
    ['admin', admin]
  ]) {
    tokens[who] = await signSessionToken(
      { id: u.id, userName: u.userName, roleType: u.roleType, store: storeA.id },
      JWT_SECRET
    )
  }
})

afterAll(async () => {
  const productIds = [productA?.id, productB?.id].filter(Boolean)
  const storeIds = [storeA?.id, storeB?.id].filter(Boolean)
  const userIds = users.map((u) => u.id)
  const quiet = (p) => Promise.resolve(p).catch(() => {})
  await quiet(db.stock_forecast.destroy({ where: { product: productIds }, force: true }))
  await quiet(db.inventory_valuation.destroy({ where: { product: productIds }, force: true }))
  await quiet(db.product_batch.destroy({ where: { id: [batchA?.id, batchB?.id] }, force: true }))
  await quiet(db.purchase_order.destroy({ where: { id: [poA?.id, poB?.id] }, force: true }))
  await quiet(db.supplier.destroy({ where: { id: supplierB?.id }, force: true }))
  await quiet(db.product_store_stock.destroy({ where: { product: productIds }, force: true }))
  await quiet(db.product_store.destroy({ where: { product: productIds }, force: true }))
  await quiet(db.product.destroy({ where: { id: productIds }, force: true }))
  await quiet(db.category.destroy({ where: { id: category?.id }, force: true }))
  await quiet(db.tenantMembership.destroy({ where: { userId: userIds } }))
  await quiet(db.authorizationContextSession.destroy({ where: { userId: userIds } }))
  await quiet(db.user.destroy({ where: { id: userIds }, force: true }))
  await quiet(db.location.destroy({ where: { id: storeIds }, force: true }))
  await quiet(db.tenant.destroy({ where: { id: tenants.map((t) => t.id) }, force: true }))
})

describe.each(['owner', 'admin'])('%s of tenant A', (who) => {
  test("supplier contacts / bank accounts of tenant B's supplier are not found", async () => {
    expect(
      (await get(who, `/supplier-contact/supplier/${supplierB.id}`)).status
    ).toBe(404)
    expect(
      (await get(who, `/supplier-bank-account/supplier/${supplierB.id}`)).status
    ).toBe(404)
  })

  test("comparing suppliers for tenant B's product is not found", async () => {
    expect(
      (await get(who, `/supplier/compare?productId=${productB.id}`)).status
    ).toBe(404)
    expect(
      (await get(who, `/supplier/compare?productId=${productA.id}`)).status
    ).toBe(200)
  })

  test("outlet prices of tenant B's product are not found", async () => {
    expect(
      (await get(who, `/pos/product/price-by-store?productId=${productB.id}`)).status
    ).toBe(404)
    expect(
      (await get(who, `/pos/product/price-by-store?productId=${productA.id}`)).status
    ).toBe(200)
  })

  test('expiring batches list only own stores', async () => {
    const res = await get(who, '/inventory/expiring-soon?days=30')
    expect(res.status).toBe(200)
    const ids = res.body.data.map((b) => b.id)
    expect(ids).toContain(batchA.id)
    expect(ids).not.toContain(batchB.id)
  })

  test("valuation of tenant B's product is not found and the total skips it", async () => {
    expect(
      (await get(who, `/inventory/valuation?productId=${productB.id}`)).status
    ).toBe(404)
    const all = await get(who, '/inventory/valuation')
    expect(all.status).toBe(200)
    const ids = all.body.data.products.map((p) => p.id)
    expect(ids).toContain(productA.id)
    expect(ids).not.toContain(productB.id)
  })

  test('purchase orders list only own stores', async () => {
    const res = await get(who, '/purchase-order/get-all?limit=100')
    expect(res.status).toBe(200)
    const rows = res.body.data?.rows || res.body.data || []
    const ids = (Array.isArray(rows) ? rows : []).map((r) => r.id)
    expect(ids).not.toContain(poB.id)
  })
})

describe('owner of tenant A', () => {
  test("cannot name tenant B's outlet in the purchase-order filter", async () => {
    const res = await get('owner', `/purchase-order/get-all?stores=${storeB.id}`)
    expect(res.status).toBe(200)
    const rows = res.body.data?.rows || res.body.data || []
    expect((Array.isArray(rows) ? rows : []).map((r) => r.id)).not.toContain(poB.id)
  })

  test("running a forecast for tenant B's product is not found and writes nothing", async () => {
    const res = await request(app)
      .post(`/inventory/forecast/run?productId=${productB.id}`)
      .set('Authorization', `Bearer ${tokens.owner}`)
    expect(res.status).toBe(404)
    expect(await db.stock_forecast.count({ where: { product: productB.id } })).toBe(0)
  })
})
