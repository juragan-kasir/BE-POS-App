process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let category = null
let product = null
let adminToken = null

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'PO_FLOW_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PO_FLOW_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PO_FLOW_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 5
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7301,
    userName: 'admin_po_flow',
    email: 'p14-7301-purchase-order-flow@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_po_flow'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7301, userName: 'admin_po_flow', roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [7301] }, force: true })
  await db.product_batch_stock.destroy({ where: {}, force: true })
  await db.product_batch.destroy({ where: { product: product?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: { store: location.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('POST /purchase-order/create + PUT /purchase-order/receive/:id — core purchasing flow', () => {
  test('creates a purchase order with items', async () => {
    const res = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        status: 'ordered',
        items: [{ product: product.id, quantity: 10, price: 5000 }]
      })

    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('ordered')
    expect(res.body.data.items.length).toBe(1)
    expect(Number(res.body.data.items[0].quantity)).toBe(10)
    expect(Number(res.body.data.totalAmount)).toBe(50000)
  })

  test('receiving the full quantity increases stock and marks the order received', async () => {
    const createRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        status: 'ordered',
        items: [{ product: product.id, quantity: 7, price: 5000 }]
      })
    expect(createRes.status).toBe(201)

    const poItemId = createRes.body.data.items[0].id
    const beforeStock = await db.product.findByPk(product.id)

    const receiveRes = await request(app)
      .put(`/purchase-order/receive/${createRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ id: poItemId, product: product.id, receivedQuantity: 7 }]
      })

    expect(receiveRes.status).toBe(200)

    const afterStock = await db.product.findByPk(product.id)
    expect(Number(afterStock.stock)).toBe(Number(beforeStock.stock) + 7)

    const order = await db.purchase_order.findByPk(createRes.body.data.id)
    expect(order.status).toBe('received')

    const poItem = await db.purchase_order_item.findByPk(poItemId)
    expect(Number(poItem.receivedQuantity)).toBe(7)

    const history = await db.stock_history.findAll({
      where: { product: product.id, referenceType: 'purchase' }
    })
    expect(history.length).toBe(1)
    expect(Number(history[0].quantityChange)).toBe(7)
  })

  test('partial receipt leaves the order in "ordered" status, not "received"', async () => {
    const createRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        status: 'ordered',
        items: [{ product: product.id, quantity: 10, price: 5000 }]
      })
    expect(createRes.status).toBe(201)

    const poItemId = createRes.body.data.items[0].id

    const receiveRes = await request(app)
      .put(`/purchase-order/receive/${createRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ id: poItemId, product: product.id, receivedQuantity: 4 }]
      })

    expect(receiveRes.status).toBe(200)

    const order = await db.purchase_order.findByPk(createRes.body.data.id)
    expect(order.status).toBe('ordered')
  })
})
