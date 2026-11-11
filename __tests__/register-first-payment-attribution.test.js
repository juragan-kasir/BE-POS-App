process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// E2E 2026-11-11 (F-05): a QR order placed a minute before the drawer was
// opened, then paid by split bill (cash + QRIS) inside the shift, was left
// out of the X/Z sales, product and per-method figures while its cash still
// counted in expectedCash. Membership must follow the first payment.

const RUN = Date.now()
let store
let category
let product
let opener
let token
let order

beforeAll(async () => {
  store = await db.location.create({ name: `FIRSTPAY_STORE_${RUN}`, status: 'active' })
  category = await db.category.create({ name: `FIRSTPAY_CAT_${RUN}` })
  product = await db.product.create({
    nameProduct: `FIRSTPAY_ITEM_${RUN}`,
    category: category.id,
    price: 22500,
    stock: 10
  })
  opener = await db.user.create({
    userName: `firstpay_opener_${RUN}`,
    email: `firstpay_opener_${RUN}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'Opener'
  })
  token = await signSessionToken(
    { id: opener.id, userName: opener.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  const placedAt = new Date(Date.now() - 60 * 1000)
  order = await db.order.create({
    store: store.id,
    orderNumber: `CUST-FIRSTPAY-${RUN}`,
    subTotal: 45000,
    taxAmount: 4500,
    totalPrice: 49500,
    totalQuantity: 2,
    status: 'pending',
    paymentStatus: 'unpaid',
    createdAt: placedAt,
    updatedAt: placedAt
  })
  await db.order_item.create({
    order: order.id,
    product: product.id,
    productName: `FIRSTPAY_ITEM_${RUN}`,
    quantity: 2,
    price: 22500,
    totalPrice: 45000
  })
})

afterAll(async () => {
  await db.transaction.destroy({ where: { order: order.id }, force: true })
  await db.order_item.destroy({ where: { order: order.id }, force: true })
  await db.order.destroy({ where: { id: order.id }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.user.destroy({ where: { id: opener.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

test('an order placed before the drawer opened counts in the shift that collected it', async () => {
  const openRes = await request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${token}`)
    .send({ store: store.id, openingBalance: 0 })
  expect([200, 201]).toContain(openRes.status)
  const registerId = openRes.body.data.id

  await db.transaction.bulkCreate([
    { order: order.id, typePayment: 'CASH', amount: 19500, cashReceived: 19500, changeGiven: 0, cashRegisterId: registerId },
    { order: order.id, typePayment: 'E_WALLET', amount: 30000, referenceNumber: `QR-${RUN}`, cashRegisterId: registerId }
  ])
  await order.update({ status: 'paid', paymentStatus: 'paid' })

  const closeRes = await request(app)
    .put(`/cash-register/close/${registerId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ store: store.id, closingBalance: 19500 })
  expect(closeRes.status).toBe(200)

  const { summary, payments, salesByProduct } = closeRes.body.data
  expect(summary.totalTransactions).toBe(1)
  expect(Number(summary.totalSales)).toBe(49500)
  expect(summary.expectedCash).toBe(19500)
  const byType = Object.fromEntries(payments.map((p) => [p.type, p.amount]))
  expect(byType.CASH).toBe(19500)
  expect(byType.E_WALLET).toBe(30000)
  expect(salesByProduct.map((p) => p.productName)).toContain(`FIRSTPAY_ITEM_${RUN}`)
})
