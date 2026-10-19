process.env.NODE_ENV = 'test'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

// AI personal assistant data API: ai-business-core reads one store's live
// data with `Authorization: Bearer $ASSISTANT_SERVICE_SECRET`. Fails closed
// until the secret is configured, and every query is confined to :storeId.

const SECRET = 'a'.repeat(40)
const TAG = `ASSIST_${Date.now()}`

let store
let otherStore
let category
let lowProduct
let okProduct
let foreignProduct
const orders = []

const get = (path, auth = `Bearer ${SECRET}`) => {
  const req = request(app).get(path)
  return auth ? req.set('Authorization', auth) : req
}

const createOrder = async (storeId, attrs, items = []) => {
  const order = await db.order.create({
    orderNumber: `${TAG}-${orders.length}`,
    store: storeId,
    ...attrs
  })
  orders.push(order)
  for (const item of items) {
    await db.order_item.create({ order: order.id, ...item })
  }
  return order
}

beforeAll(async () => {
  store = await db.location.create({ name: `${TAG}_STORE`, status: 'active', timezone: 'Asia/Jakarta' })
  otherStore = await db.location.create({ name: `${TAG}_OTHER`, status: 'active' })
  category = await db.category.create({ name: `${TAG}_CAT` })

  const makeProduct = async (name, storeId, stock, minStock) => {
    const product = await db.product.create({ nameProduct: name, category: category.id, price: 10000, stock, minStock })
    await db.product_store.create({ product: product.id, store: storeId })
    await db.product_store_stock.create({ product: product.id, store: storeId, stock })
    return product
  }

  lowProduct = await makeProduct(`${TAG} Arabica`, store.id, 2, 5)
  okProduct = await makeProduct(`${TAG} Robusta`, store.id, 40, 5)
  foreignProduct = await makeProduct(`${TAG} Arabica Foreign`, otherStore.id, 1, 5)

  const paid = { status: 'paid', paymentStatus: 'paid', paymentMethod: 'cash' }
  await createOrder(store.id, { ...paid, totalPrice: 30000, totalQuantity: 3 }, [
    { product: lowProduct.id, productName: lowProduct.nameProduct, quantity: 3, price: 10000, totalPrice: 30000 }
  ])
  await createOrder(store.id, { ...paid, paymentMethod: 'qris', totalPrice: 10000, totalQuantity: 1 }, [
    { product: okProduct.id, productName: okProduct.nameProduct, quantity: 1, price: 10000, totalPrice: 10000 }
  ])
  // Excluded: unpaid, void, and another store's sale
  await createOrder(store.id, { status: 'pending', paymentStatus: 'unpaid', totalPrice: 99000 })
  await createOrder(store.id, { status: 'void', paymentStatus: 'paid', totalPrice: 88000 })
  await createOrder(otherStore.id, { ...paid, totalPrice: 77000, totalQuantity: 7 })
})

afterAll(async () => {
  const orderIds = orders.map((o) => o.id)
  const productIds = [lowProduct, okProduct, foreignProduct].map((p) => p.id)
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.product_store_stock.destroy({ where: { product: productIds }, force: true })
  await db.product_store.destroy({ where: { product: productIds }, force: true })
  await db.product.destroy({ where: { id: productIds }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: [store.id, otherStore.id] }, force: true })
  delete process.env.ASSISTANT_SERVICE_SECRET
  await db.sequelize.close()
})

describe('service auth', () => {
  it('fails closed with 503 while ASSISTANT_SERVICE_SECRET is unset', async () => {
    delete process.env.ASSISTANT_SERVICE_SECRET
    const res = await get(`/assistant/stores/${store.id}/summary`)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('ASSISTANT_NOT_CONFIGURED')
  })

  it('rejects a missing or wrong secret with 401', async () => {
    process.env.ASSISTANT_SERVICE_SECRET = SECRET
    expect((await get(`/assistant/stores/${store.id}/summary`, null)).status).toBe(401)
    expect((await get(`/assistant/stores/${store.id}/summary`, `Bearer ${'b'.repeat(40)}`)).status).toBe(401)
  })
})

describe('store data', () => {
  beforeAll(() => {
    process.env.ASSISTANT_SERVICE_SECRET = SECRET
  })

  it('400s an invalid store id and 404s an unknown store', async () => {
    expect((await get('/assistant/stores/abc/summary')).status).toBe(400)
    expect((await get('/assistant/stores/999999999/summary')).status).toBe(404)
  })

  it('summary counts only paid, non-void sales of this store', async () => {
    const res = await get(`/assistant/stores/${store.id}/summary`)
    expect(res.status).toBe(200)
    expect(res.body.data.store.name).toBe(store.name)
    expect(res.body.data.today).toMatchObject({ revenue: 40000, orders: 2, itemsSold: 4, averageOrderValue: 20000 })
    expect(res.body.data.lowStockProducts).toBe(1)
  })

  it('stock search is confined to the store and flags low stock', async () => {
    const res = await get(`/assistant/stores/${store.id}/stock?q=${encodeURIComponent(`${TAG} Arabica`)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.products).toEqual([
      expect.objectContaining({ id: lowProduct.id, stock: 2, minStock: 5, isLow: true })
    ])

    const low = await get(`/assistant/stores/${store.id}/stock?lowOnly=true`)
    const ids = low.body.data.products.map((p) => p.id)
    expect(ids).toContain(lowProduct.id)
    expect(ids).not.toContain(okProduct.id)
    expect(ids).not.toContain(foreignProduct.id)
  })

  it('sales report totals by day and payment method', async () => {
    const res = await get(`/assistant/stores/${store.id}/sales`)
    expect(res.status).toBe(200)
    expect(res.body.data.totals).toMatchObject({ revenue: 40000, orders: 2 })
    expect(res.body.data.byDay).toHaveLength(1)
    expect(res.body.data.byPaymentMethod).toEqual([
      { method: 'cash', revenue: 30000, orders: 1 },
      { method: 'qris', revenue: 10000, orders: 1 }
    ])
  })

  it('rejects an inverted or oversized date range', async () => {
    expect((await get(`/assistant/stores/${store.id}/sales?from=2026-02-01&to=2026-01-01`)).status).toBe(400)
    expect((await get(`/assistant/stores/${store.id}/sales?from=2025-01-01&to=2026-01-01`)).status).toBe(400)
  })

  it('best sellers rank by quantity', async () => {
    const res = await get(`/assistant/stores/${store.id}/best-sellers`)
    expect(res.status).toBe(200)
    expect(res.body.data.products[0]).toMatchObject({ rank: 1, name: lowProduct.nameProduct, quantity: 3, revenue: 30000 })
  })
})

describe('owner telegram link', () => {
  it('requires a logged-in session', async () => {
    const res = await request(app).post('/assistant/telegram-link')
    expect(res.status).toBe(401)
  })
})
