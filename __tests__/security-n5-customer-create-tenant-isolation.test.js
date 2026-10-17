process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// N-5 regression: POST /order/customer-create and
// POST /waiter-request/customer-create are public/unauthenticated and derived
// the store purely from the client body, so an attacker could direct persisted
// rows AND realtime emissions into an arbitrary store. A valid table belonging
// to the claimed store is now REQUIRED, and the authoritative store is derived
// from the table (the physical QR/table is the server-authoritative
// capability). Table-less or mismatched requests are rejected and create
// nothing in the claimed store.

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

let storeA = null
let storeB = null
let tableA = null
let tableB = null
let category = null
let product = null

beforeAll(async () => {
  storeA = await db.location.create({ name: 'N5_STORE_A', status: 'active' })
  storeB = await db.location.create({ name: 'N5_STORE_B', status: 'active' })
  tableA = await db.table.create({ store: storeA.id, name: 'N5_TABLE_A' })
  tableB = await db.table.create({ store: storeB.id, name: 'N5_TABLE_B' })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed rates for
  // both stores so these isolation assertions exercise configured tax.
  for (const s of [storeA, storeB]) {
    await db.taxConfig.create({
      name: `N5_PPN_${s.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: s.id
    })
  }
  category = await db.category.create({ name: 'N5_CATEGORY', status: 'active' })
  product = await db.product.create({
    nameProduct: 'N5_Product',
    category: category.id,
    price: 1000,
    stock: 100
  })
  // DR-14: the outlet row is the authoritative stock.
  for (const s of [storeA, storeB]) {
    await db.product_store_stock.create({ product: product.id, store: s.id, stock: 100 })
  }
})

afterAll(async () => {
  await db.order_item.destroy({ where: {}, force: true })
  await db.taxConfig.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  await db.order.destroy({ where: { store: [storeA?.id, storeB?.id].filter(Boolean) }, force: true })
  await db.waiter_request.destroy({ where: {}, force: true })
  await db.table.destroy({ where: { id: [tableA?.id, tableB?.id].filter(Boolean) }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true })
})

const orderBody = (overrides = {}) => ({
  store: storeB.id,
  tableId: tableB.id,
  customerName: 'N5 Customer',
  items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
  ...overrides
})

describe('N-5 customer-create tenant isolation', () => {
  test('attacker with store B but a store A table is rejected and creates nothing in B', async () => {
    const before = await db.order.count({ where: { store: storeB.id } })
    const res = await request(app)
      .post('/order/customer-create')
      .send(orderBody({ store: storeB.id, tableId: tableA.id }))
    const after = await db.order.count({ where: { store: storeB.id } })
    expect(res.status).toBe(400)
    expect(after).toBe(before)
  })

  test('table-less order is rejected (no arbitrary store targeting without a table)', async () => {
    const before = await db.order.count({ where: { store: storeB.id } })
    const res = await request(app)
      .post('/order/customer-create')
      .send({ store: storeB.id, customerName: 'X', items: [{ productId: product.id, productName: 'X', quantity: 1 }] })
    const after = await db.order.count({ where: { store: storeB.id } })
    expect(res.status).toBe(400)
    expect(after).toBe(before)
  })

  test('legitimate store A order with store A table is created unpaid and persisted under store A', async () => {
    const res = await request(app)
      .post('/order/customer-create')
      .send(orderBody({ store: storeA.id, tableId: tableA.id }))
    expect(res.status).toBe(201)
    expect(res.body.data.paymentStatus).toBe('unpaid')
    expect(res.body.data.store).toBe(storeA.id)
    expect(res.body.data.tableId).toBe(tableA.id)
  })

  test('waiter-request with store B but a store A table is rejected and creates nothing in B', async () => {
    const before = await db.waiter_request.count()
    const res = await request(app)
      .post('/waiter-request/customer-create')
      .send({ store: storeB.id, tableId: tableA.id, type: 'refill' })
    const after = await db.waiter_request.count()
    expect(res.status).toBe(400)
    expect(after).toBe(before)
  })

  test('legitimate waiter-request for store A table is persisted under store A', async () => {
    const res = await request(app)
      .post('/waiter-request/customer-create')
      .send({ store: storeA.id, tableId: tableA.id, type: 'refill' })
    expect(res.status).toBe(201)
    const row = await db.waiter_request.findByPk(res.body.data.id)
    expect(Array.isArray(row.store) ? row.store[0] : row.store).toBe(storeA.id)
  })
})
