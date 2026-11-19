process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 2 HIGH-2 regression: getKitchenOrders built its filter from the
// client-supplied req.query.store with a fail-open `{}` fallback, so a store
// admin hitting GET /order/kitchen WITHOUT a store param read the kitchen
// queue of EVERY store. The filter must derive from the pinned req.storeId.

let store1 = null
let store2 = null
let order1 = null
let order2 = null
let category = null
let product = null
let admin1Token = null
let admin2Token = null
let superToken = null

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({ name: 'HIGH2_STORE_A', status: 'active' }))
  store2 = await db.location.create(await withTestTenant({ name: 'HIGH2_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'HIGH2_CAT', status: 'active' })
  product = await db.product.create({
    nameProduct: 'HIGH2_Product',
    category: category.id,
    price: 1000
  })

  // P1-4: central gate denies unknown caller identities; these rows give
  // the caller ids real identities. Assertions below are unchanged.
  await db.user.create({
    id: 9701,
    userName: 'high2_admin_a',
    email: 'p14-9701-high2@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store1.id,
    status: 'active',
    fullName: 'high2_admin_a'
  })
  await db.user.create({
    id: 9702,
    userName: 'high2_admin_b',
    email: 'p14-9702-high2@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store2.id,
    status: 'active',
    fullName: 'high2_admin_b'
  })
  await db.user.create({
    id: 9700,
    userName: 'high2_super',
    email: 'p14-9700-high2@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'high2_super'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  admin1Token = await signSessionToken(
    { id: 9701, userName: 'high2_admin_a', roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  admin2Token = await signSessionToken(
    { id: 9702, userName: 'high2_admin_b', roleType: 'admin', store: store2.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 9700, userName: 'high2_super', roleType: 'super_admin' },
    JWT_SECRET
  )

  order1 = await db.order.create({
    orderNumber: `HIGH2-${Date.now()}-A`,
    store: store1.id,
    status: 'paid',
    paymentStatus: 'paid',
    source: 'pos'
  })
  order2 = await db.order.create({
    orderNumber: `HIGH2-${Date.now()}-B`,
    store: store2.id,
    status: 'paid',
    paymentStatus: 'paid',
    source: 'pos'
  })
  await db.order_item.bulkCreate([
    { order: order1.id, product: product.id, quantity: 1, price: 1000, status: 'preparing' },
    { order: order2.id, product: product.id, quantity: 1, price: 2000, status: 'preparing' }
  ])
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [9701, 9702, 9700] }, force: true })
  await db.order_item.destroy({ where: { order: [order1?.id, order2?.id].filter(Boolean) }, force: true })
  await db.order.destroy({ where: { id: [order1?.id, order2?.id].filter(Boolean) }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: [store1?.id, store2?.id].filter(Boolean) }, force: true })
})

const orderNumbers = (res) =>
  (res.body.data || []).map((o) => o.orderNumber)

describe('HIGH-2 kitchen orders store scoping', () => {
  test('store1 admin without any store param sees ONLY store1 kitchen orders', async () => {
    const res = await request(app)
      .get('/order/kitchen')
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const nums = orderNumbers(res)
    expect(nums).toContain(order1.orderNumber)
    expect(nums).not.toContain(order2.orderNumber)
  })

  test('store1 admin is 403 when explicitly requesting store2', async () => {
    const res = await request(app)
      .get('/order/kitchen')
      .query({ store: store2.id })
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(403)
  })

  test('store1 admin with own store param still sees own orders', async () => {
    const res = await request(app)
      .get('/order/kitchen')
      .query({ store: store1.id })
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const nums = orderNumbers(res)
    expect(nums).toContain(order1.orderNumber)
    expect(nums).not.toContain(order2.orderNumber)
  })

  test('store1 admin does NOT see store2 orders even with store2 cookie', async () => {
    const res = await request(app)
      .get('/order/kitchen')
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const nums = orderNumbers(res)
    expect(nums).toContain(order1.orderNumber)
    expect(nums).not.toContain(order2.orderNumber)
  })

  test('super_admin without store param still sees all stores (intentional)', async () => {
    const res = await request(app)
      .get('/order/kitchen')
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    const nums = orderNumbers(res)
    expect(nums).toContain(order1.orderNumber)
    expect(nums).toContain(order2.orderNumber)
  })

  test('super_admin with store param scopes to that store', async () => {
    const res = await request(app)
      .get('/order/kitchen')
      .query({ store: store2.id })
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    const nums = orderNumbers(res)
    expect(nums).not.toContain(order1.orderNumber)
    expect(nums).toContain(order2.orderNumber)
  })
})