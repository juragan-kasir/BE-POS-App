process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// C-5 / C-6 / C-10 regression — cross-tenant reads & writes on shared
// master data that carries a store-scoped child dimension.
//
//   C-5  GET /notification          a non-super-admin could pass ?store= to
//                                   read another store's notifications. Now
//                                   foreign ?store= is rejected at the
//                                   middleware and the controller scopes to
//                                   req.storeId (pinned own).
//   C-6  GET /ingredient-category/get-by-id/:id
//                                   getById returns `ingredients` scoped only
//                                   by category id — leaking store-scoped
//                                   ingredient rows across ALL stores. Now the
//                                   ingredient subquery is store-scoped for
//                                   non-super (own store + shared null rows).
//   C-10 POST /pos/product/add-batch
//                                   a non-super-admin could add stock/batch to
//                                   a product not assigned to their store,
//                                   inflating shared product stock. Now requires
//                                   product_store membership for non-super.

const { signSessionToken } = require('../test-helpers/authSession')
const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA = null
let storeB = null
let adminAToken = null
let adminBToken = null

let notifA = null
let notifB = null

let category = null
let ingA = null
let ingB = null
let ingNull = null

let productB = null
let catForProduct = null

let batch = null

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'C5_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'C5_STORE_B', status: 'active' }))

  // P1-4: central gate denies unknown caller identities; these rows give the
  // caller ids real identities. Assertions below are unchanged.
  for (const [id, userName, roleType, userType, store] of [
    [71001, 'c5_admin_a', 'admin', 'admin', storeA.id],
    [71002, 'c5_admin_b', 'admin', 'admin', storeB.id]
  ]) {
    await db.user.create({
      id,
      userName,
      email: `p14-${id}-c5c6c10@test.com`,
      roleType,
      userType,
      store,
      status: 'active',
      fullName: userName
    })
  }
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminAToken = await signSessionToken(
    { id: 71001, userName: 'c5_admin_a', roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
  adminBToken = await signSessionToken(
    { id: 71002, userName: 'c5_admin_b', roleType: 'admin', store: storeB.id },
    JWT_SECRET
  )

  notifA = await db.notification.create({
    store: storeA.id,
    title: 'C5_NOTIF_A',
    message: 'own-store notification',
    type: 'system',
    isRead: false
  })
  notifB = await db.notification.create({
    store: storeB.id,
    title: 'C5_NOTIF_B',
    message: 'foreign-store notification',
    type: 'system',
    isRead: false
  })

  category = await db.ingredientCategory.create({ name: 'C6_CAT', status: 'active' })
  ingA = await db.ingredient.create({
    name: 'C6_ING_A',
    store: storeA.id,
    category: category.id,
    status: 'active'
  })
  ingB = await db.ingredient.create({
    name: 'C6_ING_B',
    store: storeB.id,
    category: category.id,
    status: 'active'
  })
  ingNull = await db.ingredient.create({
    name: 'C6_ING_SHARED',
    store: null,
    category: category.id,
    status: 'active'
  })

  catForProduct = await db.category.create({ name: 'C10_CAT', status: 'active' })
  productB = await db.product.create({
    nameProduct: 'C10_Product_Only_Store_B',
    category: catForProduct.id,
    price: 10000,
    stock: 10
  })
  await db.product_store.create({ product: productB.id, store: storeB.id })
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [71001, 71002] }, force: true })
  await db.product_batch.destroy({ where: { id: batch?.id }, force: true })
  await db.stock_history.destroy(
    { where: { product: productB?.id }, force: true }
  )
  await db.product_store.destroy(
    { where: { product: productB?.id }, force: true }
  )
  await db.product.destroy({ where: { id: productB?.id }, force: true })
  await db.category.destroy({ where: { id: catForProduct?.id }, force: true })
  await db.ingredient.destroy({ where: { id: [ingA?.id, ingB?.id, ingNull?.id] }, force: true })
  await db.ingredientCategory.destroy({ where: { id: category?.id }, force: true })
  await db.notification.destroy({ where: { id: [notifA?.id, notifB?.id] }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id] }, force: true })
})

describe('C-5 notification cross-tenant read', () => {
  test('store A admin cannot read store B notifications via ?store=', async () => {
    const res = await request(app)
      .get('/notification')
      .set('Authorization', `Bearer ${adminAToken}`)
      .query({ store: storeB.id })
    expect(res.status).toBe(403)
  })

  test('store A admin list only returns own-store notifications', async () => {
    const res = await request(app)
      .get('/notification')
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(200)
    const titles = (res.body.data || []).map((n) => n.title)
    expect(titles).toContain('C5_NOTIF_A')
    expect(titles).not.toContain('C5_NOTIF_B')
  })

  test('store A admin can list own notifications with explicit ?store=own', async () => {
    const res = await request(app)
      .get('/notification')
      .set('Authorization', `Bearer ${adminAToken}`)
      .query({ store: storeA.id })
    expect(res.status).toBe(200)
    const titles = (res.body.data || []).map((n) => n.title)
    expect(titles).toContain('C5_NOTIF_A')
    expect(titles).not.toContain('C5_NOTIF_B')
  })
})

describe('C-6 ingredientCategory getById ingredient scope', () => {
  test('store A admin sees own + shared ingredients, never store B ingredients', async () => {
    const res = await request(app)
      .get(`/ingredient-category/get-by-id/${category.id}`)
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(200)
    const names = (res.body.data?.ingredients || []).map((i) => i.name)
    expect(names).toContain('C6_ING_A')
    expect(names).toContain('C6_ING_SHARED')
    expect(names).not.toContain('C6_ING_B')
  })
})

describe('C-10 addBatch product-store membership', () => {
  test('store A admin cannot add batch to a product only assigned to store B', async () => {
    const res = await request(app)
      .post('/pos/product/add-batch')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        productId: productB.id,
        store: storeA.id,
        batchCode: 'C10-FOREIGN-BATCH',
        expiryDate: '2030-01-01',
        qty: 5
      })
    expect(res.status).toBe(403)

    const storedBatch = await db.product_batch.findOne({
      where: { batchCode: 'C10-FOREIGN-BATCH' }
    })
    if (storedBatch) {
      batch = storedBatch
    }
    expect(storedBatch).toBeNull()
    const prod = await db.product.findByPk(productB.id)
    expect(Number(prod.stock)).toBe(10)
  })

  test('store B admin (product owner) can add a batch', async () => {
    const res = await request(app)
      .post('/pos/product/add-batch')
      .set('Authorization', `Bearer ${adminBToken}`)
      .send({
        productId: productB.id,
        store: storeB.id,
        batchCode: 'C10-OWN-BATCH',
        expiryDate: '2030-01-01',
        qty: 7
      })
    expect(res.status).toBe(201)
    const stored = await db.product_batch.findOne({ where: { batchCode: 'C10-OWN-BATCH' } })
    if (stored) batch = stored
    const prod = await db.product.findByPk(productB.id)
    expect(Number(prod.stock)).toBe(17)
  })
})