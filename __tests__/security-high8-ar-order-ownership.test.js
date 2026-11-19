process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 2 HIGH-8 regression: accountsReceivable.create did not verify that
// the referenced order belonged to the caller's store. A store A user could
// create an accounts receivable row referencing a store B order, resulting in
// financial record fabrication and disclosure of the foreign order's customer
// name and invoice metadata.
// With the fix, the order must belong to req.storeId.

let store1 = null
let store2 = null
let order1 = null
let order2 = null
let admin1Token = null
let superToken = null

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({ name: 'HIGH8_STORE_A', status: 'active' }))
  store2 = await db.location.create(await withTestTenant({ name: 'HIGH8_STORE_B', status: 'active' }))

  const suffix = Date.now()
  const user1 = await db.user.create({
    id: 9851,
    userName: `high8_admin_a_${suffix}`,
    roleType: 'admin',
    store: store1.id,
    password: 'x'
  })
  // P1-4: central gate denies unknown caller identities; the super token id
  // gets a real row. Assertions below are unchanged.
  await db.user.create({
    id: 9850,
    userName: `high8_super_${suffix}`,
    email: `p14-9850-security-high8-ar-order-ownership-${Date.now()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: `high8_super_${suffix}`
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  admin1Token = await signSessionToken(
    { id: user1.id, userName: user1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 9850, userName: `high8_super_${suffix}`, roleType: 'super_admin' },
    JWT_SECRET
  )

  order1 = await db.order.create({
    orderNumber: `HIGH8-${Date.now()}-A`,
    store: store1.id,
    status: 'pending',
    paymentStatus: 'unpaid',
    customerName: 'Customer Store 1',
    source: 'pos'
  })
  order2 = await db.order.create({
    orderNumber: `HIGH8-${Date.now()}-B`,
    store: store2.id,
    status: 'pending',
    paymentStatus: 'unpaid',
    customerName: 'Secret Customer Store 2',
    source: 'pos'
  })
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [9850] }, force: true })
  await db.accounts_receivable.destroy({
    where: { orderId: [order1?.id, order2?.id].filter(Boolean) },
    force: true
  })
  await db.order.destroy({
    where: { id: [order1?.id, order2?.id].filter(Boolean) },
    force: true
  })
  await db.user.destroy({ where: { id: [9851] }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
})

describe('HIGH-8 accountsReceivable parent order ownership', () => {
  test('store1 admin CAN create AR for own store order', async () => {
    const res = await request(app)
      .post('/accounts-receivable/create')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        orderId: order1.id,
        totalAmount: 150000,
        customerName: 'Customer Store 1'
      })

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.data.store).toBe(store1.id)
    expect(res.body.data.orderId).toBe(order1.id)
  })

  test('store1 admin CANNOT create AR for store2 order (foreign order rejected)', async () => {
    const beforeCount = await db.accounts_receivable.count({
      where: { orderId: order2.id }
    })

    const res = await request(app)
      .post('/accounts-receivable/create')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        orderId: order2.id,
        totalAmount: 200000
      })

    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/order not found or does not belong to your store/i)

    // Verify NO AR row was created in DB
    const afterCount = await db.accounts_receivable.count({
      where: { orderId: order2.id }
    })
    expect(afterCount).toBe(beforeCount)
  })

  test('nonexistent order ID is rejected', async () => {
    const res = await request(app)
      .post('/accounts-receivable/create')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        orderId: 9999999,
        totalAmount: 50000
      })

    expect(res.status).toBe(403)
  })

  test('super_admin CAN create AR for any store order', async () => {
    const res = await request(app)
      .post('/accounts-receivable/create')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        orderId: order2.id,
        totalAmount: 200000
      })

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.data.orderId).toBe(order2.id)
  })
})
