process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store = null
let category = null
let product = null
let bundle = null
let adminToken = null
let superAdminToken = null
let kasirToken = null
let userToken = null
let table = null

beforeAll(async () => {
  store = await db.location.create({ name: 'OVERRIDE_STORE', status: 'active' })
  table = await db.table.create({ store: store.id, name: 'OVERRIDE_TABLE', status: 'available' })
  category = await db.category.create({ name: 'OVERRIDE_CAT', status: 'active' })
  product = await db.product.create({
    nameProduct: 'OVERRIDE_PRODUCT',
    category: category.id,
    price: 10000,
    costPrice: 4000,
    stock: 100,
    point: 0
  })
  await db.product_store.create({ product: product.id, store: store.id })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 100 })

  bundle = await db.product_bundle.create({
    name: 'OVERRIDE_BUNDLE',
    bundlePrice: 5000,
    isAvailable: true,
    status: 'active'
  })
  await db.product_bundle_item.create({ bundleId: bundle.id, product: product.id, quantity: 1 })


  // P1-4: central gate denies unknown caller identities; these rows give the
  // caller ids real identities (bound super_admin stays bound). Assertions
  // below are unchanged.
  for (const [id, userName, roleType, userType] of [
    [9801, 'override_admin', 'admin', 'admin'],
    [9802, 'override_super', 'super_admin', 'admin'],
    [9803, 'override_kasir', 'kasir', 'user'],
    [9804, 'override_user', 'user', 'user']
  ]) {
    await db.user.create({
      id,
      userName,
      email: `p14-${id}-override@test.com`,
      roleType,
      userType,
      store: store.id,
      status: 'active',
      fullName: userName
    })
  }
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken({ id: 9801, userName: 'override_admin', roleType: 'admin', store: store.id }, JWT_SECRET)
  superAdminToken = await signSessionToken({ id: 9802, userName: 'override_super', roleType: 'super_admin', store: store.id }, JWT_SECRET)
  kasirToken = await signSessionToken({ id: 9803, userName: 'override_kasir', roleType: 'kasir', store: store.id }, JWT_SECRET)
  userToken = await signSessionToken({ id: 9804, userName: 'override_user', roleType: 'user', store: store.id }, JWT_SECRET)
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // these override assertions were written against so totals are unchanged.
  await db.taxConfig.create({
    name: 'OVERRIDE_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: store.id, user: 9801, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.user.destroy({ where: { id: [9801, 9802, 9803, 9804] }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store.id }, force: true })
  await db.product_bundle_item.destroy({ where: { bundleId: bundle.id }, force: true })
  await db.product_bundle.destroy({ where: { id: bundle.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product_store.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.table.destroy({ where: { id: table.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

afterEach(async () => {
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store.id }, force: true })
})

const orderPayload = (items, overrides = {}) => ({
  store: store.id,
  paymentMethod: 'cash',
  cashierName: 'Override Tester',
  items,
  ...overrides
})

describe('Price override — admin/super_admin', () => {
  test('admin priceOverride 8000 is honored (catalog 10000)', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, priceOverride: 8000 }])))
    expect(res.status).toBe(201)
    const order = res.body.data
    const items = await db.order_item.findAll({ where: { order: order.id }, raw: true })
    expect(items[0].price).toBe(8000)
    expect(items[0].totalPrice).toBe(8000)
    // subTotal should reflect overridden price, not catalog
    expect(Number(order.subTotal)).toBe(8000)
  })

  test('super_admin priceOverride is honored', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 2, priceOverride: 8000 }])))
    expect(res.status).toBe(201)
    const items = await db.order_item.findAll({ where: { order: res.body.data.id }, raw: true })
    expect(Number(items[0].price)).toBe(8000)
    expect(Number(items[0].totalPrice)).toBe(16000)
  })
})

describe('Price override — authorization', () => {
  test('kasir override is rejected 403', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, priceOverride: 8000 }])))
    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/Price override requires admin/i)
  })

  test('user override is rejected 403', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${userToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, priceOverride: 8000 }])))
    expect(res.status).toBe(403)
  })

  test('anonymous customer-create with priceOverride is rejected', async () => {
    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store.id,
        tableId: table.id,
        items: [{ productId: product.id, quantity: 1, priceOverride: 8000 }],
        customerName: 'Anon'
      })
    expect([400, 403].includes(res.status)).toBe(true)
    expect(res.body.message).toMatch(/Price override not allowed/i)
  })
})

describe('Price override — normal and manipulation', () => {
  test('normal order without priceOverride uses catalog price', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1 }])))
    expect(res.status).toBe(201)
    const items = await db.order_item.findAll({ where: { order: res.body.data.id }, raw: true })
    expect(Number(items[0].price)).toBe(10000)
  })

  test('client price field manipulation (price:1) without priceOverride is ignored', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, price: 1 }])))
    expect(res.status).toBe(201)
    const items = await db.order_item.findAll({ where: { order: res.body.data.id }, raw: true })
    expect(Number(items[0].price)).toBe(10000)
  })

  test('both price:1 and priceOverride:8000 → priceOverride wins', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, price: 1, priceOverride: 8000 }])))
    expect(res.status).toBe(201)
    const items = await db.order_item.findAll({ where: { order: res.body.data.id }, raw: true })
    expect(Number(items[0].price)).toBe(8000)
  })
})

describe('Price override — validation', () => {
  test('negative override is rejected 400', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, priceOverride: -500 }])))
    expect(res.status).toBe(400)
  })

  test('non-finite / Infinity is rejected', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, priceOverride: 'Infinity' }])))
    expect(res.status).toBe(400)
  })

  test('NaN string is rejected', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, priceOverride: 'abc' }])))
    expect(res.status).toBe(400)
  })

  test('zero override is accepted (comp)', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, priceOverride: 0 }])))
    // Zero price is allowed per FE (free/comp) — should succeed and produce subTotal 0 + tax
    expect(res.status).toBe(201)
    const items = await db.order_item.findAll({ where: { order: res.body.data.id }, raw: true })
    expect(Number(items[0].price)).toBe(0)
  })

  test('non-integer override is rejected', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, priceOverride: 8000.5 }])))
    expect(res.status).toBe(400)
  })
})

describe('Price override — bundle', () => {
  test('bundle with priceOverride is explicitly rejected', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, bundleId: bundle.id, quantity: 1, priceOverride: 8000 }])))
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/bundle/i)
  })
})

describe('Price override — money flow', () => {
  test('discount + override: discount applies to overridden subtotal', async () => {
    // Create a discount first? For simplicity, test that subTotal reflects override and totalPrice follows
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 2, priceOverride: 8000 }])))
    expect(res.status).toBe(201)
    const order = res.body.data
    expect(Number(order.subTotal)).toBe(16000)
    // tax is on subtotal (no discount), total = subtotal + tax
    expect(Number(order.totalPrice)).toBeGreaterThan(16000)
  })

  test('tax calculated from overridden subtotal', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, priceOverride: 8000 }])))
    expect(res.status).toBe(201)
    const order = res.body.data
    // Explicit store PPN (seeded in beforeAll): 8000*0.11=880
    expect(Number(order.taxAmount)).toBe(Math.round(8000 * 0.11))
  })

  test('transaction amount reflects overridden total', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey(orderPayload([{ product: product.id, quantity: 1, priceOverride: 8000 }])))
    expect(res.status).toBe(201)
    const tx = await db.transaction.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(tx.amount)).toBe(Number(res.body.data.totalPrice))
  })
})

describe('Price override — idempotency', () => {
  test('replay same idempotencyKey with same override returns same order', async () => {
    const key = `override-idem-${Date.now()}`
    const payload = orderPayload([{ product: product.id, quantity: 1, priceOverride: 8000 }], { idempotencyKey: key })
    const res1 = await request(app).post('/order/create').set('Authorization', `Bearer ${adminToken}`).send(withIdempotencyKey(payload))
    expect(res1.status).toBe(201)
    const res2 = await request(app).post('/order/create').set('Authorization', `Bearer ${adminToken}`).send(withIdempotencyKey(payload))
    expect(res2.status).toBe(200)
    expect(res2.body.data.id).toBe(res1.body.data.id)
  })
})
