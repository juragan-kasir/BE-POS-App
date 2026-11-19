process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let category = null
let product = null
let table = null

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'F1801_STORE', status: 'active' }))
  category = await db.category.create({ name: 'F1801_CAT' })
  product = await db.product.create({
    nameProduct: 'F1801_PRODUCT',
    category: category.id,
    price: 100000,
    stock: 100
  })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 100 })
  table = await db.table.create({ store: location.id, name: 'F1801_TABLE', capacity: 4 })
  // Ensure tax 11% for this store
  const existing = await db.taxConfig.findOne({ where: { store: location.id, type: 'ppn' } })
  if (!existing) {
    await db.taxConfig.create({ store: location.id, name: 'PPN 11%', rate: 11, type: 'ppn', status: 'active' })
  } else {
    await existing.update({ rate: 11, status: 'active' })
  }
})

afterAll(async () => {
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.table.destroy({ where: { id: table.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.taxConfig.destroy({ where: { store: location.id, type: 'ppn' }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

// Phase 39 — a successful QR order occupies its table until paid/cancelled/
// void releases it. Each assertion here needs a fresh, independent order on
// the shared fixture table, so every booking starts from a freed table.
const createCustomerOrder = async (price) => {
  await db.table.update({ status: 'available' }, { where: { id: table.id } })
  return request(app)
    .post('/order/customer-create')
    .send({
      store: location.id,
      tableId: table.id,
      customerName: 'F1801 Customer',
      items: [{ productId: product.id, productName: 'F1801_PRODUCT', quantity: 1, price }],
      session: `test-${Date.now()}-${Math.random()}`
    })
}

describe('F18-01 BISA server price authority', () => {
  test('client price 1 is ignored, server price 100000 used', async () => {
    const res = await createCustomerOrder(1)
    expect(res.status).toBe(201)
    expect(res.body.data.subTotal).toBe(100000)
    expect(res.body.data.totalPrice).toBe(111000) // 100k + 11% tax
  })

  test('client price 999999 is ignored', async () => {
    const res = await createCustomerOrder(999999)
    expect(res.status).toBe(201)
    expect(res.body.data.subTotal).toBe(100000)
  })

  test('client price 0 is ignored', async () => {
    const res = await createCustomerOrder(0)
    expect(res.status).toBe(201)
    expect(res.body.data.subTotal).toBe(100000)
  })

  test('client price -100 is ignored', async () => {
    const res = await createCustomerOrder(-100)
    expect(res.status).toBe(201)
    expect(res.body.data.subTotal).toBe(100000)
  })

  test('tax is from server subTotal, not client', async () => {
    const res = await createCustomerOrder(1)
    expect(res.status).toBe(201)
    // tax 11% of 100000 = 11000
    expect(res.body.data.taxAmount).toBe(11000)
    expect(Number(res.body.data.taxRate)).toBe(11)
  })
})
