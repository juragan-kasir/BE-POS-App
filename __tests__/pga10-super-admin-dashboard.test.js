'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-10 (product-grade audit 2026-11-02): GET /pos/dashboard/super-admin
// returned 500 for every super_admin — `integer out of range` from ::int
// casts. The platform-wide product stock value overflowed int4, which also
// showed that aggregate was not store-scoped: a large tenant's numbers broke
// a small tenant's dashboard. Sums are now bigint and every aggregate is
// confined to the caller's outlets (all of them for the vendor).
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const P = 'pga10'
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const created = { users: [], tenants: [], stores: [], products: [], ingredients: [], queues: [], categories: [] }
let homeA
let homeB
let foreign
let ownerToken
let vendorToken
let foreignBig
let homeLow

beforeAll(async () => {
  const home = await db.tenant.create({ code: `${P}-home-${uniq()}`, name: 'PGA10 Home' })
  const other = await db.tenant.create({ code: `${P}-other-${uniq()}`, name: 'PGA10 Other' })
  created.tenants.push(home.id, other.id)
  homeA = await db.location.create({ name: `PGA10_A_${uniq()}`, status: 'active', tenantId: home.id })
  homeB = await db.location.create({ name: `PGA10_B_${uniq()}`, status: 'active', tenantId: home.id })
  foreign = await db.location.create({ name: `PGA10_F_${uniq()}`, status: 'active', tenantId: other.id })
  created.stores.push(homeA.id, homeB.id, foreign.id)
  const category = await db.category.create({ name: `PGA10_CAT_${uniq()}` })
  created.categories.push(category.id)

  // Another tenant's catalog worth Rp 5 billion at cost: > int4 max.
  foreignBig = await db.product.create({
    nameProduct: `PGA10_FOREIGN_${uniq()}`,
    category: category.id,
    price: 60000,
    costPrice: 50000,
    stock: 100000,
    minStock: 200000,
    status: 'active'
  })
  await db.product_store.create({ product: foreignBig.id, store: foreign.id })
  // Own product at outlet B (not the owner's home outlet A), low on stock.
  homeLow = await db.product.create({
    nameProduct: `PGA10_HOME_${uniq()}`,
    category: category.id,
    price: 2000,
    costPrice: 1000,
    stock: 10,
    minStock: 20,
    status: 'active'
  })
  await db.product_store.create({ product: homeLow.id, store: homeB.id })
  created.products.push(foreignBig.id, homeLow.id)

  const ingB = await db.ingredient.create({ name: `PGA10_ING_B_${uniq()}`, store: homeB.id, stock: 1, minStock: 5, costPrice: 100, status: 'active', unit: 'gram' })
  const ingF = await db.ingredient.create({ name: `PGA10_ING_F_${uniq()}`, store: foreign.id, stock: 1, minStock: 5, costPrice: 100, status: 'active', unit: 'gram' })
  created.ingredients.push(ingB.id, ingF.id)

  const q = await db.queue.create({
    queueNumber: `PGA10-${uniq()}`,
    customerName: 'Tamu Lain',
    partySize: 2,
    status: 'waiting',
    store: [foreign.id],
    checkedInAt: new Date()
  })
  created.queues.push(q.id)

  const owner = await db.user.create({
    userName: `${P}_owner_${uniq()}`,
    email: `${P}_owner_${uniq()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: homeA.id,
    status: 'active'
  })
  const vendor = await db.user.create({
    userName: `${P}_vendor_${uniq()}`,
    email: `${P}_vendor_${uniq()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active'
  })
  created.users.push(owner.id, vendor.id)
  await db.tenantMembership.create({ userId: owner.id, tenantId: home.id, role: 'tenant_admin', status: 'ACTIVE' })

  ownerToken = await signSessionToken(
    { id: owner.id, userName: owner.userName, roleType: 'super_admin', store: homeA.id },
    JWT_SECRET
  )
  vendorToken = await signSessionToken(
    { id: vendor.id, userName: vendor.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.queue.destroy({ where: { id: created.queues }, force: true })
  await db.ingredient.destroy({ where: { id: created.ingredients }, force: true })
  await db.product_store.destroy({ where: { product: created.products }, force: true })
  await db.product.destroy({ where: { id: created.products }, force: true })
  await db.category.destroy({ where: { id: created.categories }, force: true })
  await db.tenantMembership.destroy({ where: { userId: created.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
  await db.tenant.destroy({ where: { id: created.tenants }, force: true })
})

const get = (token, qs = '') =>
  request(app).get(`/pos/dashboard/super-admin${qs}`).set('Authorization', `Bearer ${token}`)

describe('PGA-10 — super-admin dashboard', () => {
  test('a multi-outlet owner gets 200 and only its own outlets in every aggregate', async () => {
    const res = await get(ownerToken)
    expect(res.status).toBe(200)
    const data = res.body.data

    // Stock value: only the owner's product (10 × 1.000), never the other
    // tenant's Rp 5 billion.
    expect(data.operations.productStockValue).toBe(10000)
    expect(data.operations.queueWaiting).toBe(0)
    expect(data.summary.lowStockCount).toBeGreaterThanOrEqual(2)
    const body = JSON.stringify(data)
    expect(body).toContain(homeLow.nameProduct)
    expect(body).not.toContain(foreignBig.nameProduct)
    expect(body).toContain('PGA10_ING_B_')
    expect(body).not.toContain('PGA10_ING_F_')
  })

  test('picking one outlet narrows to that outlet', async () => {
    const res = await get(ownerToken, `?store=${homeA.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data.operations.productStockValue).toBe(0)
    expect(JSON.stringify(res.body.data)).not.toContain(homeLow.nameProduct)
  })

  test('the vendor super admin sees every outlet and the big figure no longer overflows', async () => {
    const res = await get(vendorToken)
    expect(res.status).toBe(200)
    expect(res.body.data.operations.productStockValue).toBeGreaterThanOrEqual(5000000000 + 10000)
    expect(res.body.data.operations.queueWaiting).toBeGreaterThanOrEqual(1)
  })
})
