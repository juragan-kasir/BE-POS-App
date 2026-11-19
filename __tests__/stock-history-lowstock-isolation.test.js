process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 12 — low-stock consistency audit.
//
// GET /stock-history/low-stock (stockHistoryController.getLowStock) scopes
// its INGREDIENT query by req.storeId, but its PRODUCT query
// (`db.product.findAll({ where: { status: 'active', minStock: { [Op.gt]: 0 } } })`)
// carries NO store filter at all — every other low-stock view in this
// codebase scopes products by store for a non-super_admin caller:
//   - getDashboardSummary's raw SQL low-stock COUNT adds
//     `AND EXISTS (SELECT 1 FROM product_store ps WHERE ps.product = p.id
//     AND ps.store = :store)` when a store is resolved.
//   - getLowStockAll explodes products through the same product_store
//     membership and filters by storeId.
// getLowStock is the one place this was missed, so a store-A admin calling
// it sees every other store's low-stock products too — a real cross-store
// data leak, proven here with real HTTP + real store-scoped JWTs.

let storeA = null
let storeB = null
let category = null
let productStoreA = null
let productStoreB = null
let adminAUser = null
let adminAToken = null

const nextTag = () => `LS_ISO_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'LS_ISO_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'LS_ISO_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'LS_ISO_CATEGORY' })

  productStoreA = await db.product.create({
    nameProduct: nextTag(),
    category: category.id,
    price: 10000,
    status: 'active',
    stock: 2,
    minStock: 10
  })
  productStoreB = await db.product.create({
    nameProduct: nextTag(),
    category: category.id,
    price: 10000,
    status: 'active',
    stock: 1,
    minStock: 10
  })

  await db.product_store.create({ product: productStoreA.id, store: storeA.id })
  await db.product_store.create({ product: productStoreB.id, store: storeB.id })

  adminAUser = await db.user.create({
    userName: 'admin_ls_iso_a',
    email: 'admin_ls_iso_a@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active'
  })
  adminAToken = await signSessionToken(
    { id: adminAUser.id, userName: adminAUser.userName, roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.product_store.destroy({
    where: { product: [productStoreA?.id, productStoreB?.id] },
    force: true
  })
  await db.product.destroy({
    where: { id: [productStoreA?.id, productStoreB?.id] },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: adminAUser?.id }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id] }, force: true })
})

describe('GET /stock-history/low-stock — product store isolation', () => {
  test('a store-A admin does not see store-B-only low-stock products', async () => {
    const res = await request(app)
      .get('/stock-history/low-stock')
      .set('Authorization', `Bearer ${adminAToken}`)

    expect(res.status).toBe(200)

    const returnedIds = res.body.data.products.map((p) => p.id)
    expect(returnedIds).toContain(productStoreA.id)
    expect(returnedIds).not.toContain(productStoreB.id)
  })
})
