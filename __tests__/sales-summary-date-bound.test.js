process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let adminToken = null
let recentOrder = null
let oldOrder = null

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'SALES_SUMMARY_STORE', status: 'active' }))

  // P1-4: central gate denies unknown caller identities; this row gives the
  // caller id a real identity. Assertions below are unchanged.
  await db.user.create({
    id: 7901,
    userName: 'admin_sales_summary',
    email: 'p14-7901-sales-summary@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_sales_summary'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7901, userName: 'admin_sales_summary', roleType: 'admin', store: location.id },
    JWT_SECRET
  )

  const now = new Date()
  const fortyDaysAgo = new Date(now.getTime() - 40 * 86400000)

  recentOrder = await db.order.create({
    orderNumber: `SS-RECENT-${Date.now()}`,
    store: location.id,
    status: 'paid',
    paymentStatus: 'paid',
    totalPrice: 50000,
    createdAt: now,
    updatedAt: now
  })

  oldOrder = await db.order.create({
    orderNumber: `SS-OLD-${Date.now()}`,
    store: location.id,
    status: 'paid',
    paymentStatus: 'paid',
    totalPrice: 70000,
    createdAt: fortyDaysAgo,
    updatedAt: fortyDaysAgo
  })
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [7901] }, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('GET /report/sales-summary — no-filter case must be bounded, not a full-table scan', () => {
  test('with no filter/date params, only recent (within-window) orders are counted, not all-time', async () => {
    const res = await request(app)
      .get('/report/sales-summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Cookie', [`store=${location.id}`])

    expect(res.status).toBe(200)
    // The 40-day-old order must be excluded by the default bound; only
    // the recent order's 50000 should be counted, not 50000 + 70000.
    expect(Number(res.body.data.totalSales)).toBe(50000)
    expect(Number(res.body.data.totalOrders)).toBe(1)
  })

  test('an explicit wide date range still works and includes the old order', async () => {
    const start = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10)
    // +1 day so the date-only string's implied midnight boundary doesn't
    // exclude an order created later today.
    const end = new Date(Date.now() + 86400000).toISOString().slice(0, 10)

    const res = await request(app)
      .get('/report/sales-summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Cookie', [`store=${location.id}`])
      .query({ startDate: start, endDate: end })

    expect(res.status).toBe(200)
    expect(Number(res.body.data.totalSales)).toBe(120000)
    expect(Number(res.body.data.totalOrders)).toBe(2)
  })
})

describe('GET /report/sales-summary — per-store breakdown (derived from the grouped chart query, not N+1)', () => {
  let locA = null
  let locB = null
  let superAdminToken = null

  beforeAll(async () => {
    locA = await db.location.create(await withTestTenant({ name: 'SALES_SUMMARY_STORE_A', status: 'active' }))
    locB = await db.location.create(await withTestTenant({ name: 'SALES_SUMMARY_STORE_B', status: 'active' }))

    // P1-4: central gate denies unknown caller identities; this row gives the
    // caller id a real identity. Assertions below are unchanged.
    await db.user.create({
      id: 7902,
      userName: 'superadmin_sales_summary',
      email: 'p14-7902-sales-summary@test.com',
      roleType: 'super_admin',
      userType: 'admin',
      store: null,
      status: 'active',
      fullName: 'superadmin_sales_summary'
    })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
    superAdminToken = await signSessionToken(
      { id: 7902, userName: 'superadmin_sales_summary', roleType: 'super_admin' },
      JWT_SECRET
    )

    const now = new Date()
    await db.order.create({
      orderNumber: `SS-A-${Date.now()}`,
      store: locA.id,
      status: 'paid',
      paymentStatus: 'paid',
      totalPrice: 10000,
      createdAt: now,
      updatedAt: now
    })
    await db.order.create({
      orderNumber: `SS-B1-${Date.now()}`,
      store: locB.id,
      status: 'paid',
      paymentStatus: 'paid',
      totalPrice: 20000,
      createdAt: now,
      updatedAt: now
    })
    await db.order.create({
      orderNumber: `SS-B2-${Date.now()}`,
      store: locB.id,
      status: 'paid',
      paymentStatus: 'paid',
      totalPrice: 5000,
      createdAt: now,
      updatedAt: now
    })
  })

  afterAll(async () => {
    await db.user.destroy({ where: { id: [7902] }, force: true })
    await db.order.destroy({ where: { store: [locA.id, locB.id] }, force: true })
    await db.location.destroy({ where: { id: [locA?.id, locB?.id] }, force: true })
  })

  test('each store in the breakdown gets its own correctly-summed totals', async () => {
    const res = await request(app)
      .get('/report/sales-summary')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .query({ filter: 'today' })

    expect(res.status).toBe(200)
    const storeA = res.body.data.stores.find((s) => s.id === locA.id)
    const storeB = res.body.data.stores.find((s) => s.id === locB.id)

    expect(storeA.sales).toBe(10000)
    expect(storeA.transactions).toBe(1)
    expect(storeB.sales).toBe(25000)
    expect(storeB.transactions).toBe(2)
  })
})
