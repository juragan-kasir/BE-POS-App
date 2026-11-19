process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store = null
let category = null
let product = null
let token = null

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'F28_02_STORE', status: 'active' }))
  category = await db.category.create({ name: 'F28_02_CAT' })
  product = await db.product.create({ nameProduct: 'F28_02_PROD', category: category.id, price: 50000, stock: 1000 })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 98010,
    userName: 'f28_admin',
    email: 'p14-98010-report-daily-discount-fix@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'f28_admin'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  token = await signSessionToken({ id: 98010, userName: 'f28_admin', roleType: 'admin', store: store.id }, JWT_SECRET)
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [98010] }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

afterEach(async () => {
  await db.order_item.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store.id }, force: true })
})

const makeOrderWithDiscount = async ({ subTotal, discountAmount, totalPrice }) => {
  const order = await db.order.create({
    orderNumber: `F28-02-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    store: store.id,
    status: 'paid',
    paymentStatus: 'paid',
    subTotal,
    discountAmount,
    totalQuantity: 1,
    totalPrice,
    totalCovers: 1,
    source: 'pos',
    createdAt: new Date()
  })
  await db.order_item.create({
    order: order.id,
    product: product.id,
    productName: product.nameProduct,
    quantity: 1,
    price: subTotal,
    totalPrice: subTotal,
    hppSnapshot: 20000,
    status: 'served'
  })
  return order
}

describe('F28-02 discount double subtraction fix', () => {
  test('order with discount must not double-subtract', async () => {
    // subTotal 50000, discount 5000, totalPrice 45000 (already net of discount, tax 0)
    // If bug exists, daily netRevenue = totalPrice(45000) - discount(5000) = 40000 (wrong)
    // Correct: netRevenue = subTotal(50000) - discount(5000) = 45000 OR totalPrice(45000) = 45000
    await makeOrderWithDiscount({ subTotal: 50000, discountAmount: 5000, totalPrice: 45000 })

    const rangeStart = new Date(Date.now() - 86400000).toISOString().slice(0,10)
    const rangeEnd = new Date(Date.now() + 86400000).toISOString().slice(0,10)
    const res = await request(app)
      .get('/report/daily')
      .set('Authorization', `Bearer ${token}`)
      .query({ startDate: rangeStart, endDate: rangeEnd })

    expect(res.status).toBe(200)
    const rows = res.body.data
    expect(rows.length).toBeGreaterThan(0)
    // Sum across all returned days for this store (in case timezone shifts)
    const totalBersih = rows.reduce((s, r) => s + (r.totalPenjualanBersih || 0), 0)
    // The correct net revenue should be 45000, not 40000
    expect(totalBersih).toBe(45000)
    const totalHpp = rows.reduce((s, r) => s + (r.totalHpp || 0), 0)
    const grossProfit = rows.reduce((s, r) => s + (r.grossProfit || 0), 0)
    expect(totalHpp).toBe(20000)
    expect(grossProfit).toBe(25000)
  })

  test('order with zero discount must be unaffected', async () => {
    await makeOrderWithDiscount({ subTotal: 50000, discountAmount: 0, totalPrice: 50000 })

    const rangeStart = new Date(Date.now() - 86400000).toISOString().slice(0,10)
    const rangeEnd = new Date(Date.now() + 86400000).toISOString().slice(0,10)
    const res = await request(app)
      .get('/report/daily')
      .set('Authorization', `Bearer ${token}`)
      .query({ startDate: rangeStart, endDate: rangeEnd })

    expect(res.status).toBe(200)
    const rows = res.body.data
    const totalBersih = rows.reduce((s, r) => s + (r.totalPenjualanBersih || 0), 0)
    expect(totalBersih).toBe(50000)
  })
})
