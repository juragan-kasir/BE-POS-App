process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 2 HIGH-1 regression: reporting endpoints trusted the client cookie
// (req.cookies.store) to determine the store context, allowing a store A
// admin to set a cookie for store B and view store B's sales/product/
// category/kasir summaries. The store must come from the authenticated
// user's JWT store (req.storeId) only.

let store1 = null
let store2 = null
let admin1Token = null
let superToken = null
let category1 = null
let product1 = null
let kasirUser = null

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({ name: 'HIGH1_STORE_A', status: 'active' }))
  store2 = await db.location.create(await withTestTenant({ name: 'HIGH1_STORE_B', status: 'active' }))

  category1 = await db.category.create({ name: 'HIGH1_CAT', status: 'active' })
  product1 = await db.product.create({
    nameProduct: 'HIGH1_PROD',
    category: category1.id,
    price: 1000
  })

  const suffix = Date.now()
  const user1 = await db.user.create({
    id: 9901,
    userName: `high1_admin_a_${suffix}`,
    roleType: 'admin',
    store: store1.id,
    password: 'x'
  })

  // P1-4: central gate denies unknown caller identities; the super token id
  // needs a real row (9901/9902 already exist above). Assertions unchanged.
  await db.user.create({
    id: 9900,
    userName: `high1_super_${suffix}`,
    email: `p14-9900-high1-${suffix}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: `high1_super_${suffix}`
  })

  kasirUser = await db.user.create({
    id: 9902,
    userName: `high1_kasir_${suffix}`,
    roleType: 'kasir',
    store: store1.id,
    password: 'x'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  admin1Token = await signSessionToken(
    { id: user1.id, userName: user1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 9900, userName: `high1_super_${suffix}`, roleType: 'super_admin' },
    JWT_SECRET
  )

  const today = new Date().toISOString().slice(0, 10)
  await db.sales_summary.bulkCreate([
    { store: store1.id, report_date: today, total_sales: 1000, total_transactions: 10 },
    { store: store2.id, report_date: today, total_sales: 2000, total_transactions: 20 }
  ])
  await db.product_sales_summary.bulkCreate([
    { store: store1.id, report_date: today, product: product1.id, revenue: 500, quantity_sold: 5 },
    { store: store2.id, report_date: today, product: product1.id, revenue: 800, quantity_sold: 8 }
  ])
  await db.category_sales_summary.bulkCreate([
    { store: store1.id, report_date: today, category: category1.id, revenue: 300, quantity_sold: 3 },
    { store: store2.id, report_date: today, category: category1.id, revenue: 600, quantity_sold: 6 }
  ])
  await db.kasir_performance.bulkCreate([
    { store: store1.id, cashier: kasirUser.id, report_date: today, total_sales: 150, transactions: 3 },
    { store: store2.id, cashier: kasirUser.id, report_date: today, total_sales: 250, transactions: 4 }
  ])
})

afterAll(async () => {
  const storeIds = [store1?.id, store2?.id].filter(Boolean)
  await db.kasir_performance.destroy({ where: { store: storeIds }, force: true })
  await db.category_sales_summary.destroy({ where: { store: storeIds }, force: true })
  await db.product_sales_summary.destroy({ where: { store: storeIds }, force: true })
  await db.sales_summary.destroy({ where: { store: storeIds }, force: true })
  await db.product.destroy({ where: { id: product1?.id }, force: true })
  await db.category.destroy({ where: { id: category1?.id }, force: true })
  await db.user.destroy({ where: { id: [9901, 9902, 9900] }, force: true })
  await db.location.destroy({ where: { id: storeIds }, force: true })
})

describe('HIGH-1 reporting endpoints must not trust client cookie', () => {
  test('getSalesSummary ignores foreign cookie and returns only own store data', async () => {
    const res = await request(app)
      .get('/reports/sales-summary')
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].store).toBe(store1.id)
    expect(Number(res.body.data[0].total_sales)).toBe(1000)
  })

  test('getProductSalesSummary ignores foreign cookie and returns only own store data', async () => {
    const res = await request(app)
      .get('/reports/product-sales')
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].store).toBe(store1.id)
    expect(Number(res.body.data[0].revenue)).toBe(500)
  })

  test('getCategorySalesSummary ignores foreign cookie and returns only own store data', async () => {
    const res = await request(app)
      .get('/reports/category-sales')
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].store).toBe(store1.id)
    expect(Number(res.body.data[0].revenue)).toBe(300)
  })

  test('getKasirPerformance ignores foreign cookie and returns only own store data', async () => {
    const res = await request(app)
      .get('/reports/kasir-performance')
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].store).toBe(store1.id)
    expect(Number(res.body.data[0].total_sales)).toBe(150)
  })

  test('getSalesSummary rejects foreign store query param with 403', async () => {
    const res = await request(app)
      .get('/reports/sales-summary')
      .query({ store: store2.id })
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(403)
  })

  test('super_admin can view all stores reporting data', async () => {
    const res = await request(app)
      .get('/reports/sales-summary')
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    const stores = res.body.data.map((r) => r.store)
    expect(stores).toContain(store1.id)
    expect(stores).toContain(store2.id)
  })
})