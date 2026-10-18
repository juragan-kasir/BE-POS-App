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
let taxConfig = null
let cashierToken = null

beforeAll(async () => {
  location = await db.location.create({ name: 'TAX_STORE', status: 'active' })
  category = await db.category.create({ name: 'TAX_CAT' })
  product = await db.product.create({
    nameProduct: 'TAX_PRODUCT',
    category: category.id,
    price: 15000,
    stock: 100
  })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 100 })
  // Ensure tax config 11% exists for this store
  taxConfig = await db.taxConfig.findOne({ where: { store: location.id, type: 'ppn' } })
  if (!taxConfig) {
    taxConfig = await db.taxConfig.create({
      store: location.id,
      type: 'ppn',
      rate: 11,
      status: 'active',
      name: 'PPN'
    })
  } else {
    await taxConfig.update({ rate: 11, status: 'active' })
  }
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 9802,
    userName: 'tax_cashier',
    email: 'p14-9802-phase18-tax-toggle@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: location.id,
    status: 'active',
    fullName: 'tax_cashier'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  cashierToken = await signSessionToken(
    { id: 9802, userName: 'tax_cashier', roleType: 'kasir', store: location.id },
    JWT_SECRET
  )
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: location.id, user: 9802, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.user.destroy({ where: { id: [9802] }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.taxConfig.destroy({ where: { id: taxConfig?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

const createOrder = (body) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send(withIdempotencyKey({
      store: location.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'Tax Cashier',
      ...body
    }))

describe('DR-24 D-01 — cashier tax toggle removed', () => {
  test('useTax false is ignored → tax still charged from the resolved rate (1650/16650)', async () => {
    const res = await createOrder({ useTax: false })
    expect(res.status).toBe(201)
    expect(res.body.data.taxAmount).toBe(1650)
    expect(res.body.data.totalPrice).toBe(16650)
  })

  test('useTax absent charges the resolved rate (1650/16650)', async () => {
    const res = await createOrder({})
    expect(res.status).toBe(201)
    expect(res.body.data.taxAmount).toBe(1650)
    expect(res.body.data.totalPrice).toBe(16650)
  })

  test('client fake taxRate 0 with useTax true is ignored', async () => {
    const res = await createOrder({ useTax: true, taxRate: 0, taxAmount: 0, totalPrice: 15000 })
    expect(res.status).toBe(201)
    expect(res.body.data.taxAmount).toBe(1650)
    expect(res.body.data.totalPrice).toBe(16650)
  })

  test('client fake taxAmount with useTax false is ignored — tax still charged', async () => {
    const res = await createOrder({ useTax: false, taxRate: 11, taxAmount: 1650, totalPrice: 16650 })
    expect(res.status).toBe(201)
    expect(res.body.data.taxAmount).toBe(1650)
    expect(res.body.data.totalPrice).toBe(16650)
  })

  test('a tax-free outlet is configured explicitly — a 0 % row charges no tax', async () => {
    await taxConfig.update({ rate: 0 })
    try {
      const res = await createOrder({ useTax: true })
      expect(res.status).toBe(201)
      expect(res.body.data.taxAmount).toBe(0)
      expect(res.body.data.totalPrice).toBe(15000)
    } finally {
      await taxConfig.update({ rate: 11 })
    }
  })
})
