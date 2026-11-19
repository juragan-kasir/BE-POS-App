process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 2 HIGH-10 regression tests:
// The report export subsystem (/report-export/export/:key) relied on report definitions
// (api/service/reportDefs/*.js) that derived tenant scope from req.cookies?.store
// or req.query.store, allowing a Store A tenant to set Cookie: store=StoreB and export
// Store B's sensitive sales, product sales, category sales, and cashier performance data.
//
// These tests verify that:
// 1. Tenant admin A without store selector receives only Store A data.
// 2. Tenant admin A sending Cookie: store=Store B does NOT receive Store B data.
// 3. Tenant admin A sending ?store=Store B is blocked with 403.
// 4. Conflicting cookie/query values cannot escape Store A boundary.
// 5. Tenant admin B receives only Store B data.
// 6. Super admin can access individual stores or all-store global data.
// 7. Unassigned non-super-admin (store: null) is rejected with 403 (fail-closed).
// 8. The exported CSV payload content itself is inspected to prove absence of foreign data.

let store1 = null
let store2 = null
let admin1Token = null
let admin2Token = null
let unassignedToken = null
let superToken = null
let category1 = null
let product1 = null
let product2 = null
let cashierUser1 = null
let cashierUser2 = null

beforeAll(async () => {
  const suffix = Date.now()
  store1 = await db.location.create(await withTestTenant({ name: `HIGH10_STORE_A_${suffix}`, status: 'active' }))
  store2 = await db.location.create(await withTestTenant({ name: `HIGH10_STORE_B_${suffix}`, status: 'active' }))

  category1 = await db.category.create({ name: `HIGH10_CAT_${suffix}`, status: 'active' })
  product1 = await db.product.create({
    nameProduct: `HIGH10_PROD_A_${suffix}`,
    category: category1.id,
    price: 15000,
    status: 'active'
  })
  product2 = await db.product.create({
    nameProduct: `HIGH10_PROD_B_${suffix}`,
    category: category1.id,
    price: 25000,
    status: 'active'
  })

  const user1 = await db.user.create({
    id: 9911,
    userName: `high10_admin_a_${suffix}`,
    roleType: 'admin',
    store: store1.id,
    password: 'x'
  })
  const user2 = await db.user.create({
    id: 9912,
    userName: `high10_admin_b_${suffix}`,
    roleType: 'admin',
    store: store2.id,
    password: 'x'
  })
  const userUnassigned = await db.user.create({
    id: 9913,
    userName: `high10_unassigned_${suffix}`,
    roleType: 'admin',
    store: null,
    password: 'x'
  })
  const userSuper = await db.user.create({
    id: 9910,
    userName: `high10_super_${suffix}`,
    roleType: 'super_admin',
    password: 'x'
  })

  cashierUser1 = await db.user.create({
    id: 9914,
    userName: `high10_cashier1_${suffix}`,
    fullName: `Cashier Store A ${suffix}`,
    roleType: 'kasir',
    store: store1.id,
    password: 'x'
  })
  cashierUser2 = await db.user.create({
    id: 9915,
    userName: `high10_cashier2_${suffix}`,
    fullName: `Cashier Store B ${suffix}`,
    roleType: 'kasir',
    store: store2.id,
    password: 'x'
  })

  admin1Token = await signSessionToken(
    { id: user1.id, userName: user1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  admin2Token = await signSessionToken(
    { id: user2.id, userName: user2.userName, roleType: 'admin', store: store2.id },
    JWT_SECRET
  )
  unassignedToken = await signSessionToken(
    { id: userUnassigned.id, userName: userUnassigned.userName, roleType: 'admin', store: null },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: userSuper.id, userName: userSuper.userName, roleType: 'super_admin' },
    JWT_SECRET
  )

  const today = new Date().toISOString().slice(0, 10)

  // Seed product sales summary
  await db.product_sales_summary.bulkCreate([
    {
      store: store1.id,
      product: product1.id,
      report_date: today,
      quantity_sold: 10,
      revenue: 150000,
      cost: 100000,
      profit: 50000
    },
    {
      store: store2.id,
      product: product2.id,
      report_date: today,
      quantity_sold: 20,
      revenue: 500000,
      cost: 300000,
      profit: 200000
    }
  ])

  // Seed category sales summary
  await db.category_sales_summary.bulkCreate([
    {
      store: store1.id,
      category: category1.id,
      report_date: today,
      quantity_sold: 10,
      revenue: 150000,
      cost: 100000,
      profit: 50000
    },
    {
      store: store2.id,
      category: category1.id,
      report_date: today,
      quantity_sold: 20,
      revenue: 500000,
      cost: 300000,
      profit: 200000
    }
  ])

  // Seed cashier performance
  await db.kasir_performance.bulkCreate([
    {
      store: store1.id,
      cashier: cashierUser1.id,
      report_date: today,
      total_sales: 150000,
      transactions: 5,
      items_sold: 10
    },
    {
      store: store2.id,
      cashier: cashierUser2.id,
      report_date: today,
      total_sales: 500000,
      transactions: 12,
      items_sold: 20
    }
  ])
})

afterAll(async () => {
  const storeIds = [store1?.id, store2?.id].filter(Boolean)
  await db.kasir_performance.destroy({ where: { store: storeIds }, force: true })
  await db.category_sales_summary.destroy({ where: { store: storeIds }, force: true })
  await db.product_sales_summary.destroy({ where: { store: storeIds }, force: true })
  await db.product.destroy({ where: { id: [product1?.id, product2?.id].filter(Boolean) }, force: true })
  await db.category.destroy({ where: { id: category1?.id }, force: true })
  await db.user.destroy({ where: { id: [9910, 9911, 9912, 9913, 9914, 9915] }, force: true })
  await db.location.destroy({ where: { id: storeIds }, force: true })
})

describe('HIGH-10: Report Export Tenant Isolation & Cookie Bypass Prevention', () => {
  test('1. Store A admin exports product-sales CSV and receives only Store A data', async () => {
    const res = await request(app)
      .get('/report/export/productSales')
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const csv = res.text
    expect(csv).toContain(product1.nameProduct)
    expect(csv).not.toContain(product2.nameProduct)
    expect(csv).toContain('150.000')
    expect(csv).not.toContain('500.000')
  })

  test('2. Store A admin with Cookie: store=Store B MUST NOT receive Store B data in export', async () => {
    const res = await request(app)
      .get('/report/export/productSales')
      .query({ format: 'csv' })
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const csv = res.text
    // Crucial: Must still be Store A data, NOT Store B
    expect(csv).toContain(product1.nameProduct)
    expect(csv).not.toContain(product2.nameProduct)
    expect(csv).not.toContain('500000')
  })

  test('3. Store A admin sending ?store=Store B is blocked with 403', async () => {
    const res = await request(app)
      .get('/report/export/productSales')
      .query({ format: 'csv', store: store2.id })
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(403)
  })

  test('4. Store A admin sending conflicting query and cookie remains strictly within Store A', async () => {
    const res = await request(app)
      .get('/report/export/productSales')
      .query({ format: 'csv', store: store1.id })
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const csv = res.text
    expect(csv).toContain(product1.nameProduct)
    expect(csv).not.toContain(product2.nameProduct)
  })

  test('5. Store B admin exports product-sales and receives only Store B data', async () => {
    const res = await request(app)
      .get('/report/export/productSales')
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${admin2Token}`)

    expect(res.status).toBe(200)
    const csv = res.text
    expect(csv).toContain(product2.nameProduct)
    expect(csv).not.toContain(product1.nameProduct)
    expect(csv).toContain('500.000')
    expect(csv).not.toContain('150.000')
  })

  test('6. Store A admin with Cookie: store=Store B in categorySales export does NOT leak Store B', async () => {
    const res = await request(app)
      .get('/report/export/categorySales')
      .query({ format: 'csv' })
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const csv = res.text
    // Store A has 150000 revenue, Store B has 500000 revenue
    expect(csv).toContain('150.000')
    expect(csv).not.toContain('500.000')
  })

  test('7. Store A admin with Cookie: store=Store B in kasirPerformance export does NOT leak Store B', async () => {
    const res = await request(app)
      .get('/report/export/kasirPerformance')
      .query({ format: 'csv' })
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const csv = res.text
    expect(csv).toContain(cashierUser1.fullName)
    expect(csv).not.toContain(cashierUser2.fullName)
    expect(csv).not.toContain('500000')
  })

  test('8. Unassigned admin (store: null) attempting export is rejected with 403', async () => {
    const res = await request(app)
      .get('/report/export/productSales')
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${unassignedToken}`)

    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/store assignment required/i)
  })

  test('9. Super admin can export all stores without store filter', async () => {
    const res = await request(app)
      .get('/report/export/productSales')
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    const csv = res.text
    expect(csv).toContain(product1.nameProduct)
    expect(csv).toContain(product2.nameProduct)
  })

  test('10. Super admin can export a specific store with ?store parameter', async () => {
    const res = await request(app)
      .get('/report/export/productSales')
      .query({ format: 'csv', store: store2.id })
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    const csv = res.text
    expect(csv).toContain(product2.nameProduct)
    expect(csv).not.toContain(product1.nameProduct)
  })

  test('11. Store A admin with Cookie: store=Store B in sales export only receives Store A', async () => {
    const res = await request(app)
      .get('/report/export/sales')
      .query({ format: 'csv' })
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const csv = res.text
    expect(csv).toContain(store1.name)
    expect(csv).not.toContain(store2.name)
  })

  test('12. Store A admin with Cookie: store=Store B in bestSeller export only receives Store A', async () => {
    const res = await request(app)
      .get('/report/export/bestSeller')
      .query({ format: 'csv' })
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const csv = res.text
    expect(csv).not.toContain(`Toko: ${store2.id}`)
  })
})
