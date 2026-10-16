process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// C-12 regression — client price trust on the public QR ordering endpoint.
//
// createCustomerOrder is unauthenticated. The server re-derives every item's
// price from the DB (getServerItemPrice / bundle.bundlePrice) and overwrites
// any client-supplied item.price BEFORE computing subtotals/totals. This locks
// in that a customer cannot lower the amount the cashier collects by sending a
// manipulated price/total.

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

let store = null
let table = null
let category = null
let product = null

beforeAll(async () => {
  store = await db.location.create({ name: 'C12_STORE', status: 'active' })
  table = await db.table.create({ store: store.id, name: 'C12_TABLE' })
  category = await db.category.create({ name: 'C12_CAT', status: 'active' })
  product = await db.product.create({
    nameProduct: 'C12_Product',
    category: category.id,
    price: 50000,
    stock: 100
  })
  await db.product_store.create({ product: product.id, store: store.id })
  // DR-14: the outlet row is the authoritative stock.
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 100 })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these price-integrity assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'C12_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.order_item.destroy({ where: { product: product?.id }, force: true })
  await db.order.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product_store.destroy(
    { where: { product: product?.id }, force: true }
  )
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.table.destroy({ where: { id: table?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

const orderBody = (overrides = {}) => ({
  store: store.id,
  tableId: table.id,
  customerName: 'C12 Customer',
  items: [
    {
      productId: product.id,
      productName: product.nameProduct,
      quantity: 2,
      price: 1, // attacker-controlled, must be ignored
      subtotal: 2 // must be ignored
    }
  ],
  ...overrides
})

describe('C-12 public customer price/billing integrity', () => {
  test('manipulated unit price is ignored; persisted order uses authoritative price', async () => {
    const res = await request(app)
      .post('/order/customer-create')
      .send(orderBody())
    expect(res.status).toBe(201)

    const data = res.body.data || res.body
    const orderId = data.id
    const items = await db.order_item.findAll({
      where: { order: orderId },
      raw: true
    })
    expect(items.length).toBe(1)
    expect(Number(items[0].price)).toBe(50000)
    expect(Number(items[0].totalPrice)).toBe(100000)
  })

  test('server recomputes subtotal; attacker cannot set a near-zero total', async () => {
    // Phase 39 — a successful QR order occupies its table until paid/cancelled/
    // void releases it; the previous test already booked this table, so start
    // from a freed table for this independent order.
    await db.table.update({ status: 'available' }, { where: { id: table.id } })
    const res = await request(app)
      .post('/order/customer-create')
      .send(orderBody())
    const data = res.body.data || res.body
    const items = await db.order_item.findAll({
      where: { order: data.id },
      raw: true
    })
    const total = items.reduce((s, i) => s + Number(i.totalPrice), 0)
    expect(total).toBe(100000)
  })
})
