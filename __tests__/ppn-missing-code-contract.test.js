process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const crypto = require('crypto')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// TDD RED: checkout missing-PPN must expose machine-readable PPN_MISSING,
// matching GET /tax-config/effective. Currently checkout returns HTTP 400
// { error } without a code.
let location = null
let category = null
let productA = null
let cashierToken = null
let tableA = null

beforeAll(async () => {
  location = await db.location.create({ name: 'PPN_CODE_STORE', status: 'active' })
  category = await db.category.create({ name: 'PPN_CODE_CATEGORY' })
  productA = await db.product.create({
    nameProduct: 'PPN_CODE_PRODUCT_A',
    category: category.id,
    price: 10000,
    stock: 100
  })
  await db.product_store_stock.create({ product: productA.id, store: location.id, stock: 100 })
  await db.user.create({
    id: 7003,
    userName: 'cashier_ppn_code',
    email: 'p14-7003-ppn-code@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: location.id,
    status: 'active',
    fullName: 'cashier_ppn_code'
  })
  cashierToken = await signSessionToken(
    { id: 7003, userName: 'cashier_ppn_code', roleType: 'kasir', store: location.id },
    JWT_SECRET
  )
  await db.cashRegister.create({ store: location.id, user: 7003, status: 'open', openingBalance: 0, openedAt: new Date() })
  tableA = await db.table.create({ store: location.id, name: 'PPN_CODE_TABLE', capacity: 4 })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.user.destroy({ where: { id: [7003] }, force: true })
  await db.taxConfig.destroy({ where: { store: location?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: null, name: 'PPN_CODE_GLOBAL' }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location?.id }, force: true })
  await db.table.destroy({ where: { id: tableA?.id }, force: true })
  await db.best_selling.destroy({ where: { productId: productA?.id }, force: true })
  await db.stock_history.destroy({ where: { product: productA?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: productA?.id }, force: true })
  await db.product.destroy({ where: { id: productA?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

async function clearTax() {
  await db.taxConfig.destroy({ where: { store: location.id }, force: true })
  await db.taxConfig.destroy({ where: { store: null, name: 'PPN_CODE_GLOBAL' }, force: true })
}

describe('PPN_MISSING machine-readable code on checkout paths', () => {
  test('POST /order/create missing PPN returns 400 with code PPN_MISSING', async () => {
    await clearTax()
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [{ product: productA.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'PPN Code'
      }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('PPN_MISSING')
    expect(String(res.body.error || res.body.message || '')).toMatch(/PPN tax configuration is missing/)
  })

  test('POST /order/customer-create missing PPN returns 400 with code PPN_MISSING', async () => {
    await clearTax()
    await db.table.update({ status: 'available' }, { where: { id: tableA.id } })
    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: location.id,
        tableId: tableA.id,
        customerName: 'PPN Code QR',
        items: [{ productId: productA.id, productName: 'PPN_CODE_PRODUCT_A', quantity: 1 }],
        session: `ppn-code-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`
      })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('PPN_MISSING')
    expect(String(res.body.error || res.body.message || '')).toMatch(/PPN tax configuration is missing/)
  })

  test('GET /order/customer-tax-rate missing PPN returns 400 with code PPN_MISSING', async () => {
    await clearTax()
    const res = await request(app).get(`/order/customer-tax-rate?store=${location.id}`)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('PPN_MISSING')
    expect(String(res.body.message || res.body.error || '')).toMatch(/PPN tax configuration is missing/)
  })
})
