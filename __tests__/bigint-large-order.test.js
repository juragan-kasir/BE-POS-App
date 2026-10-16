process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let category = null
let product = null
let cashierToken = null

beforeAll(async () => {
  location = await db.location.create({ name: 'BIGINT_STORE', status: 'active' })
  category = await db.category.create({ name: 'BIGINT_CAT' })
  product = await db.product.create({
    nameProduct: 'BIGINT_PRODUCT',
    category: category.id,
    price: 1000000,
    stock: 10000
  })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 10000 })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 9803,
    userName: 'bigint_cashier',
    email: 'p14-9803-bigint-large-order@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: location.id,
    status: 'active',
    fullName: 'bigint_cashier'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  cashierToken = await signSessionToken(
    { id: 9803, userName: 'bigint_cashier', roleType: 'kasir', store: location.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so this overflow assertion exercises configured tax.
  await db.taxConfig.create({
    name: 'BIGINT_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: location.id, user: 9803, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.user.destroy({ where: { id: [9803] }, force: true })
  await db.taxConfig.destroy({ where: { store: location.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

describe('INFO-02 BIGINT large order', () => {
  test('price 1M * qty 3000 = 3B subtotal persists without overflow', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [{ product: product.id, quantity: 3000 }],
        paymentMethod: 'cash',
        cashierName: 'BigInt Cashier'
      }))
    expect(res.status).toBe(201)
    expect(res.body.data.subTotal).toBe(3000000000)
    expect(res.body.data.totalPrice).toBe(3000000000 + res.body.data.taxAmount)
    expect(typeof res.body.data.subTotal).toBe('number')
    expect(typeof res.body.data.totalPrice).toBe('number')
    // Verify DB persistence
    const order = await db.order.findByPk(res.body.data.id)
    expect(Number(order.subTotal)).toBe(3000000000)
    expect(Number(order.totalPrice)).toBeGreaterThan(3000000000)
  })

  test('boundary 2147483647 + 1', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [{ product: product.id, quantity: 2148 }],
        paymentMethod: 'cash',
        cashierName: 'BigInt Cashier'
      }))
    // 1M * 2148 = 2148000000 > 2^31-1
    expect(res.status).toBe(201)
    expect(Number(res.body.data.subTotal)).toBe(2148000000)
  })
})
