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
  location = await db.location.create({ name: 'INFO01_STORE', status: 'active' })
  category = await db.category.create({ name: 'INFO01_CAT' })
  product = await db.product.create({
    nameProduct: 'INFO01_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100
  })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 100 })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 9701,
    userName: 'info01_cashier',
    email: 'p14-9701-info01-quantity-validation@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: location.id,
    status: 'active',
    fullName: 'info01_cashier'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  cashierToken = await signSessionToken(
    { id: 9701, userName: 'info01_cashier', roleType: 'kasir', store: location.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these quantity assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'INFO01_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: location.id, user: 9701, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.user.destroy({ where: { id: [9701] }, force: true })
  await db.taxConfig.destroy({ where: { store: location?.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

const createOrder = (items) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send(withIdempotencyKey({
      store: location.id,
      items,
      paymentMethod: 'cash',
      cashierName: 'INFO01 Cashier'
    }))

describe('INFO-01 quantity > 0 invariant', () => {
  test('quantity 0 is rejected (400) and does not create order', async () => {
    const before = await db.order.count({ where: { store: location.id } })
    const res = await createOrder([{ product: product.id, quantity: 0 }])
    expect(res.status).toBe(400)
    expect(res.body.message || res.body.error || '').toMatch(/quantity/i)
    const after = await db.order.count({ where: { store: location.id } })
    expect(after).toBe(before)
  })

  test('quantity -1 is rejected', async () => {
    const res = await createOrder([{ product: product.id, quantity: -1 }])
    expect(res.status).toBe(400)
    expect(res.body.message || res.body.error || '').toMatch(/quantity/i)
  })

  test('quantity 1 is accepted (201)', async () => {
    const res = await createOrder([{ product: product.id, quantity: 1 }])
    expect(res.status).toBe(201)
    expect(res.body.data).toBeTruthy()
    expect(res.body.data.totalPrice).toBeGreaterThan(0)
  })

  test('non-finite quantity NaN is rejected', async () => {
    const res = await createOrder([{ product: product.id, quantity: NaN }])
    // JSON.stringify(NaN) becomes null on wire, but direct controller call with NaN would be via JS; via HTTP it becomes null
    // We test via explicit string "NaN" and via missing/null as malformed
    expect([400, 422].includes(res.status)).toBe(true)
  })

  test('Infinity quantity is rejected', async () => {
    const res = await createOrder([{ product: product.id, quantity: Infinity }])
    // Infinity serializes to null as well, so expect rejection for malformed
    expect([400, 422].includes(res.status)).toBe(true)
  })

  test('string quantity "abc" is rejected', async () => {
    const res = await createOrder([{ product: product.id, quantity: 'abc' }])
    expect(res.status).toBe(400)
  })
})
