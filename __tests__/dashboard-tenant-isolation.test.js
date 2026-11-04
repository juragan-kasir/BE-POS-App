process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA = null
let storeB = null
let userA = null
let adminAToken = null
let category = null
let lowStockProductA = null
let lowStockProductB = null

beforeAll(async () => {
  storeA = await db.location.create({ name: 'DASH_ISO_STORE_A', status: 'active' })
  storeB = await db.location.create({ name: 'DASH_ISO_STORE_B', status: 'active' })
  category = await db.category.create({ name: 'DASH_ISO_CATEGORY' })

  // F21-01 fixtures: one low-stock product per store, each assigned only to
  // its own store via product_store (the same store-membership table the
  // already-correct getLowStockAll reference implementation uses).
  lowStockProductA = await db.product.create({
    nameProduct: 'DASH_ISO_LOWSTOCK_A',
    category: category.id,
    price: 5000,
    stock: 1,
    minStock: 5,
    status: 'active'
  })
  await db.product_store.create({ product: lowStockProductA.id, store: storeA.id })

  lowStockProductB = await db.product.create({
    nameProduct: 'DASH_ISO_LOWSTOCK_B',
    category: category.id,
    price: 5000,
    stock: 1,
    minStock: 5,
    status: 'active'
  })
  await db.product_store.create({ product: lowStockProductB.id, store: storeB.id })

  await db.member.create({ store: storeA.id, name: 'Member A', phoneNumber: '0800000001' })
  await db.member.create({ store: storeB.id, name: 'Member B', phoneNumber: '0800000002' })

  userA = await db.user.create({
    userName: 'dash_iso_user_a',
    email: 'dash_iso_user_a@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active'
  })
  await db.user.create({
    userName: 'dash_iso_user_b',
    email: 'dash_iso_user_b@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeB.id,
    status: 'active'
  })

  await db.order.create({
    orderNumber: `DASH-ISO-A-${Date.now()}`,
    store: storeA.id,
    status: 'paid',
    paymentStatus: 'paid',
    totalPrice: 15000,
    createdAt: new Date(),
    updatedAt: new Date()
  })
  await db.order.create({
    orderNumber: `DASH-ISO-B-${Date.now()}`,
    store: storeB.id,
    status: 'paid',
    paymentStatus: 'paid',
    totalPrice: 40000,
    createdAt: new Date(),
    updatedAt: new Date()
  })

  adminAToken = await signSessionToken(
    { id: userA.id, userName: userA.userName, roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.order.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  await db.member.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  await db.user.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  await db.product_store.destroy({
    where: { product: [lowStockProductA?.id, lowStockProductB?.id] },
    force: true
  })
  await db.product.destroy({
    where: { id: [lowStockProductA?.id, lowStockProductB?.id] },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id] }, force: true })
})

describe('Dashboard endpoints must not leak cross-tenant data when ?store= is omitted', () => {
  // For every endpoint below, adminAToken belongs only to storeA. Before
  // the fix, omitting ?store= (which the route-level validateStoreAccess
  // middleware allows — it only rejects a MISMATCHED store, not a missing
  // one) fell through to reading req.query.store directly in the
  // controller, which is undefined when omitted, and every one of these
  // endpoints then returned platform-wide data instead of stopping at
  // storeA. req.storeId (what the middleware actually verified and set)
  // must be what the controller uses instead.

  test('GET /overview/location does not count every location in the deployment', async () => {
    const res = await request(app)
      .get('/overview/location')
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(1)
  })

  test('GET /overview/user does not count every user in the deployment', async () => {
    const res = await request(app)
      .get('/overview/user')
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(1)
  })

  test('GET /overview/member does not count every member in the deployment', async () => {
    const res = await request(app)
      .get('/overview/member')
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(1)
  })

  test('GET /overview/locations/latest only returns the caller\'s own location', async () => {
    const res = await request(app)
      .get('/overview/locations/latest')
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(storeA.id)
  })

  test('GET /best-selling/get-chart-current-and-seven-days-before scopes order counts to the caller\'s own store', async () => {
    const res = await request(app)
      .get('/best-selling/get-chart-current-and-seven-days-before')
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(200)
    // storeA has 1 order today; storeB's order must not be counted in.
    const today = res.body.data.find((d) => Number(d.count) > 0)
    expect(today).toBeDefined()
    expect(Number(today.count)).toBe(1)
  })

  test('GET /best-selling/get-earning-today scopes revenue to the caller\'s own store', async () => {
    const res = await request(app)
      .get('/best-selling/get-earning-today')
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(200)
    // Only storeA's 15000 order, never storeB's 40000 — 55000 would mean
    // the leak is back.
    expect(Number(res.body.data.totalEarningToday)).toBe(15000)
    expect(Number(res.body.data.totalSellingToday)).toBe(1)
  })

  // F21-01: getDashboardSummary's low-stock PRODUCT count query had no
  // store filter at all (unlike the sibling ingredient count query three
  // lines below it, which already scoped correctly), while the analogous
  // low-stock DETAIL list elsewhere in the codebase already scopes products
  // to their own store via the product_store membership table. Store B's
  // low-stock product must not inflate Store A's dashboard count.
  test('GET /pos/dashboard/summary low-stock count only reflects products assigned to the caller\'s own store', async () => {
    const res = await request(app)
      .get('/pos/dashboard/summary')
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(200)
    // storeA owns exactly one low-stock product (lowStockProductA) and must
    // never be inflated by storeB's low-stock product — before the fix this
    // counted every low-stock product in the whole deployment.
    expect(Number(res.body.data.lowStock)).toBe(1)
  })

  // PGA-14 (product-grade audit 2026-11-02): totalProducts was 1,519 at
  // every outlet (every tenant's catalog) and totalMembers counted every
  // tenant's members.
  test('GET /pos/dashboard/summary product and member totals count only the caller\'s own store', async () => {
    const res = await request(app)
      .get('/pos/dashboard/summary')
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.data.totalProducts)).toBe(1)
    expect(Number(res.body.data.totalMembers)).toBe(1)
  })
})
