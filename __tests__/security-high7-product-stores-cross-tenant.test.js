process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 2 HIGH-7 regression: product create, edit, and import allowed tenant
// admins to bind products to foreign stores via the stores[] array, manipulate
// another tenant's shadow stock via cookie/body storeId, and import into
// foreign stores.
// With the fix, stores[] and shadow-stock operations are strictly bounded
// to req.storeId for tenant admins.

let store1 = null
let store2 = null
let category = null
let admin1Token = null
let superToken = null
let createdProductIds = []

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({ name: 'HIGH7_STORE_A', status: 'active' }))
  store2 = await db.location.create(await withTestTenant({ name: 'HIGH7_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'HIGH7_CAT', status: 'active' })

  const suffix = Date.now()
  const user1 = await db.user.create({
    id: 9751,
    userName: `high7_admin_a_${suffix}`,
    roleType: 'admin',
    store: store1.id,
    password: 'x'
  })
  // P1-4: central gate denies unknown caller identities; the super token id
  // gets a real row. Assertions below are unchanged.
  await db.user.create({
    id: 9750,
    userName: `high7_super_${suffix}`,
    email: `p14-9750-security-high7-product-stores-cross-tenant-${Date.now()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: `high7_super_${suffix}`
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  admin1Token = await signSessionToken(
    { id: user1.id, userName: user1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 9750, userName: `high7_super_${suffix}`, roleType: 'super_admin' },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [9750] }, force: true })
  if (createdProductIds.length > 0) {
    await db.product_store_stock.destroy({
      where: { product: createdProductIds },
      force: true
    })
    await db.product_store.destroy({
      where: { product: createdProductIds },
      force: true
    })
    await db.stock_history.destroy({
      where: { product: createdProductIds },
      force: true
    })
    await db.product.destroy({
      where: { id: createdProductIds },
      force: true
    })
  }
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: [9751] }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
})

describe('HIGH-7 product stores[] array & shadow stock tenant boundary', () => {
  test('tenant admin can create product assigned to OWN store', async () => {
    const res = await request(app)
      .post('/product/add-product')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        nameProduct: `HIGH7_PROD_OWN_${Date.now()}`,
        category: category.id,
        price: 10000,
        stock: 10,
        stores: [store1.id]
      })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const prodId = res.body.data.id
    createdProductIds.push(prodId)

    const bindings = await db.product_store.findAll({ where: { product: prodId } })
    expect(bindings.map((b) => b.store)).toEqual([store1.id])
  })

  test('tenant admin cannot create product assigned to FOREIGN store (rejected with 403)', async () => {
    const res = await request(app)
      .post('/product/add-product')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        nameProduct: `HIGH7_PROD_FOR_${Date.now()}`,
        category: category.id,
        price: 10000,
        stock: 10,
        stores: [store2.id]
      })

    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/hanya dapat menambahkan produk ke toko Anda sendiri/i)
  })

  test('tenant admin cannot create product with MIXED stores containing foreign store', async () => {
    const res = await request(app)
      .post('/product/add-product')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        nameProduct: `HIGH7_PROD_MIX_${Date.now()}`,
        category: category.id,
        price: 10000,
        stock: 10,
        stores: [store1.id, store2.id]
      })

    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/hanya dapat menambahkan produk ke toko Anda sendiri/i)
  })

  test('super_admin can create product with multi-store assignments', async () => {
    const res = await request(app)
      .post('/product/add-product')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        nameProduct: `HIGH7_PROD_SUPER_${Date.now()}`,
        category: category.id,
        price: 10000,
        stock: 20,
        stores: [store1.id, store2.id]
      })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const prodId = res.body.data.id
    createdProductIds.push(prodId)

    const bindings = await db.product_store.findAll({ where: { product: prodId } })
    const storeIds = bindings.map((b) => b.store)
    expect(storeIds).toContain(store1.id)
    expect(storeIds).toContain(store2.id)
  })

  test('tenant admin edit cannot bind product to foreign store in stores[]', async () => {
    // Create an unassigned product
    const unassigned = await db.product.create({
      nameProduct: `HIGH7_UNASSIGNED_${Date.now()}`,
      category: category.id,
      price: 5000,
      stock: 5
    })
    createdProductIds.push(unassigned.id)

    const res = await request(app)
      .put('/product/edit-product')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        id: unassigned.id,
        nameProduct: unassigned.nameProduct,
        stores: [store2.id]
      })

    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/hanya dapat mengubah produk untuk toko Anda sendiri/i)
  })

  test('tenant admin edit with foreign Cookie: store does NOT write shadow stock to foreign store', async () => {
    const prod = await db.product.create({
      nameProduct: `HIGH7_COOKIE_PROD_${Date.now()}`,
      category: category.id,
      price: 5000,
      stock: 10
    })
    createdProductIds.push(prod.id)
    await db.product_store.create({ product: prod.id, store: store1.id })

    const res = await request(app)
      .put('/product/edit-product')
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        id: prod.id,
        nameProduct: prod.nameProduct,
        stock: 25
      })

    expect(res.status).toBe(200)

    // Shadow stock in store2 must NOT exist
    const foreignStock = await db.product_store_stock.findOne({
      where: { product: prod.id, store: store2.id }
    })
    expect(foreignStock).toBeNull()

    // Shadow stock in store1 SHOULD exist
    const ownStock = await db.product_store_stock.findOne({
      where: { product: prod.id, store: store1.id }
    })
    expect(ownStock).not.toBeNull()
    expect(Number(ownStock.stock)).toBe(15) // +15 diff
  })
})
