process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 3 — P2: new read-only GET /bom/get-by-product/:productId,
// added so a product-editing page can ask "does this product already have
// a BOM" (and if so, which one) without pulling the full BOM list or
// duplicating bom_header's own existence check.

let storeA = null
let storeB = null
let category = null
let productWithBom = null
let productWithoutBom = null
let bomHeader = null
let adminA = null
let adminB = null
let tokenA = null
let tokenB = null
let superToken = null

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'BOM_GBP_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'BOM_GBP_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'BOM_GBP_CATEGORY' })

  productWithBom = await db.product.create({
    nameProduct: 'BOM_GBP_PRODUCT_WITH_BOM',
    category: category.id,
    price: 20000,
    inventoryMode: 'hybrid'
  })
  productWithoutBom = await db.product.create({
    nameProduct: 'BOM_GBP_PRODUCT_WITHOUT_BOM',
    category: category.id,
    price: 15000,
    inventoryMode: 'stocked'
  })

  bomHeader = await db.bom_header.create({
    store: storeA.id,
    productId: productWithBom.id,
    name: 'BOM_GBP_RECIPE',
    status: 'active'
  })

  adminA = await db.user.create({
    userName: 'admin_bom_gbp_a',
    email: 'admin_bom_gbp_a@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active'
  })
  adminB = await db.user.create({
    userName: 'admin_bom_gbp_b',
    email: 'admin_bom_gbp_b@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeB.id,
    status: 'active'
  })


  // P1-4: central gate denies unknown caller identities; this row gives the
  // super token id a real identity (adminA/adminB rows already exist above).
  // Assertions below are unchanged.
  await db.user.create({
    id: 9998,
    userName: 'super_bom_gbp',
    email: 'p14-9998-bom-gbp@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'super_bom_gbp'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  tokenA = await signSessionToken(
    { id: adminA.id, userName: adminA.userName, roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
  tokenB = await signSessionToken(
    { id: adminB.id, userName: adminB.userName, roleType: 'admin', store: storeB.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 9998, userName: 'super_bom_gbp', roleType: 'super_admin' },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.bom_line.destroy({ where: { bomHeaderId: bomHeader?.id }, force: true })
  await db.bom_header.destroy({ where: { id: bomHeader?.id }, force: true })
  await db.product.destroy({
    where: { id: [productWithBom?.id, productWithoutBom?.id] },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: [adminA?.id, adminB?.id, 9998] }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id] }, force: true })
})

describe('GET /bom/get-by-product/:productId', () => {
  test('returns the BOM when one exists for the product in the caller\'s own store', async () => {
    const res = await request(app)
      .get(`/bom/get-by-product/${productWithBom.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(bomHeader.id)
    expect(res.body.data.productId).toBe(productWithBom.id)
  })

  test('returns 404 when no BOM exists for the product', async () => {
    const res = await request(app)
      .get(`/bom/get-by-product/${productWithoutBom.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(404)
  })

  test('store isolation: a different store\'s admin cannot see this product\'s BOM', async () => {
    const res = await request(app)
      .get(`/bom/get-by-product/${productWithBom.id}`)
      .set('Authorization', `Bearer ${tokenB}`)

    expect(res.status).toBe(404)
  })

  test('super_admin can see the BOM regardless of store', async () => {
    const res = await request(app)
      .get(`/bom/get-by-product/${productWithBom.id}`)
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(bomHeader.id)
  })
})
