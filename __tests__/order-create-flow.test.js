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
let productA = null
let productB = null
let bundle = null
let discount = null
let cashierToken = null

beforeAll(async () => {
  location = await db.location.create({ name: 'ORD_FLOW_STORE', status: 'active' })
  category = await db.category.create({ name: 'ORD_FLOW_CATEGORY' })

  productA = await db.product.create({
    nameProduct: 'ORD_FLOW_PRODUCT_A',
    category: category.id,
    price: 15000,
    stock: 20
  })
  productB = await db.product.create({
    nameProduct: 'ORD_FLOW_PRODUCT_B',
    category: category.id,
    price: 5000,
    stock: 10
  })

  // getEffectiveStock() prefers a product_store_stock row over the base
  // product.stock once one exists — seed it to match, mirroring a store that
  // has already been through stock opname/goods receipt (the realistic
  // pre-condition for a store that's taking sales).
  await db.product_store_stock.create({
    product: productA.id,
    store: location.id,
    stock: productA.stock
  })
  await db.product_store_stock.create({
    product: productB.id,
    store: location.id,
    stock: productB.stock
  })

  bundle = await db.product_bundle.create({
    name: 'ORD_FLOW_COMBO',
    bundlePrice: 8000,
    isAvailable: true,
    status: 'active'
  })
  await db.product_bundle_item.create({
    bundleId: bundle.id,
    product: productB.id,
    quantity: 2
  })

  discount = await db.discount.create({
    name: 'ORD_FLOW_DISCOUNT',
    type: 'nominal',
    value: 2000,
    store: location.id,
    status: 'active'
  })

  // createdBy/userId columns on order/order_item/transaction/stock_history
  // carry no FK constraint, so a synthetic JWT subject is fine here (unlike
  // attendance, which does FK to a real user row).
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7001,
    userName: 'cashier_ord_flow',
    email: 'p14-7001-order-create-flow@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: location.id,
    status: 'active',
    fullName: 'cashier_ord_flow'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  cashierToken = await signSessionToken(
    { id: 7001, userName: 'cashier_ord_flow', roleType: 'kasir', store: location.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // these flow assertions were written against so totals are unchanged.
  await db.taxConfig.create({
    name: 'ORD_FLOW_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: location.id, user: 7001, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.user.destroy({ where: { id: [7001] }, force: true })
  await db.taxConfig.destroy({ where: { store: location.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.best_selling.destroy({
    where: { productId: [productA?.id, productB?.id] },
    force: true
  })
  await db.stock_history.destroy({
    where: { product: [productA?.id, productB?.id] },
    force: true
  })
  await db.product_store_stock.destroy({
    where: { product: [productA?.id, productB?.id] },
    force: true
  })
  await db.product_bundle_item.destroy({ where: { bundleId: bundle?.id }, force: true })
  await db.product_bundle.destroy({ where: { id: bundle?.id }, force: true })
  await db.discount.destroy({ where: { id: discount?.id }, force: true })
  await db.product.destroy({ where: { id: [productA?.id, productB?.id] }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('POST /order/create — core sale flow', () => {
  test('creates a paid order, deducts stock, records payment and best_selling', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [{ product: productA.id, quantity: 3 }],
        paymentMethod: 'cash',
        cashierName: 'Test Cashier'
      }))

    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('paid')
    expect(res.body.data.paymentStatus).toBe('paid')
    expect(res.body.data.items.length).toBe(1)
    expect(Number(res.body.data.items[0].quantity)).toBe(3)
    // Server re-derives price from the DB — never trusts a client-sent amount.
    expect(Number(res.body.data.items[0].price)).toBe(15000)
    // An explicit store PPN row (seeded in beforeAll) prices the order:
    // 11% tax, 0% service charge (no service-charge rows configured).
    expect(Number(res.body.data.subTotal)).toBe(45000)
    expect(Number(res.body.data.taxAmount)).toBe(4950)
    expect(Number(res.body.data.totalPrice)).toBe(49950)

    const freshProduct = await db.product.findByPk(productA.id)
    expect(Number(freshProduct.stock)).toBe(17)

    const payments = await db.transaction.findAll({
      where: { order: res.body.data.id }
    })
    expect(payments.length).toBe(1)
    expect(Number(payments[0].amount)).toBe(49950)

    const bestSelling = await db.best_selling.findAll({
      where: { productId: productA.id, store: location.id }
    })
    expect(bestSelling.length).toBe(1)
    expect(Number(bestSelling[0].totalSelling)).toBe(3)
  })

  test('a second sale of the same product/store accumulates into the same best_selling row', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [{ product: productA.id, quantity: 2 }],
        paymentMethod: 'cash',
        cashierName: 'Test Cashier'
      }))
    expect(res.status).toBe(201)

    // Race-safe atomic upsert (unique index on productId/store) instead of
    // findOne + conditional create/update — must accumulate, never duplicate.
    const bestSelling = await db.best_selling.findAll({
      where: { productId: productA.id, store: location.id }
    })
    expect(bestSelling.length).toBe(1)
    expect(Number(bestSelling[0].totalSelling)).toBe(5) // 3 from the first sale + 2 here
  })

  test('rejects an order when requested quantity exceeds available stock', async () => {
    const before = await db.product.findByPk(productA.id)

    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [{ product: productA.id, quantity: 9999 }],
        paymentMethod: 'cash',
        cashierName: 'Test Cashier'
      }))

    expect(res.status).toBe(400)

    const after = await db.product.findByPk(productA.id)
    expect(Number(after.stock)).toBe(Number(before.stock))
  })

  test('applies a nominal discountId to the order total', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [{ product: productA.id, quantity: 1 }],
        discountId: discount.id,
        paymentMethod: 'cash',
        cashierName: 'Test Cashier'
      }))

    expect(res.status).toBe(201)
    expect(Number(res.body.data.discountAmount)).toBe(2000)
    // (15000 - 2000) + 11% tax = 13000 + 1430
    expect(Number(res.body.data.totalPrice)).toBe(14430)
  })

  test('bundle order deducts the bundle component product stock, not the bundle itself', async () => {
    const beforeB = await db.product.findByPk(productB.id)
    expect(Number(beforeB.stock)).toBe(10)

    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [
          {
            product: productB.id,
            bundleId: bundle.id,
            quantity: 2,
            productName: bundle.name
          }
        ],
        paymentMethod: 'cash',
        cashierName: 'Test Cashier'
      }))

    expect(res.status).toBe(201)
    expect(res.body.data.items.length).toBe(1)
    expect(res.body.data.items[0].bundleId).toBe(bundle.id)
    // bundlePrice 8000 x qty 2
    expect(Number(res.body.data.subTotal)).toBe(16000)

    // Bundle item = productB x2 per bundle unit, order quantity 2 => 4 units deducted.
    const afterB = await db.product.findByPk(productB.id)
    expect(Number(afterB.stock)).toBe(6)
  })
})

describe('GET /order/customer-order/:token and /order/receipt-html/:token — unauthenticated, must not be enumerable by id', () => {
  test('the raw numeric order id no longer works as a lookup key', async () => {
    const createRes = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [{ product: productA.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'Test Cashier'
      }))
    expect(createRes.status).toBe(201)
    const { id: orderId, publicToken } = createRes.body.data

    expect(typeof publicToken).toBe('string')
    expect(publicToken.length).toBeGreaterThanOrEqual(32)
    // Not derivable from (or equal to) the sequential id.
    expect(publicToken).not.toBe(String(orderId))

    // The vulnerability: guessing/incrementing the plain integer id used to
    // return the order with zero credentials. It must 404 now.
    const byId = await request(app).get(`/order/customer-order/${orderId}`)
    expect(byId.status).toBe(404)

    const byIdReceipt = await request(app).get(`/order/receipt-html/${orderId}`)
    expect(byIdReceipt.status).toBe(404)

    // The real token still works — the endpoint stays usable for the
    // legitimate no-login QR-order-tracking flow.
    const byToken = await request(app).get(`/order/customer-order/${publicToken}`)
    expect(byToken.status).toBe(200)
    expect(byToken.body.data.id).toBe(orderId)

    const byTokenReceipt = await request(app).get(`/order/receipt-html/${publicToken}`)
    expect(byTokenReceipt.status).toBe(200)
    expect(byTokenReceipt.text).toContain(createRes.body.data.orderNumber)
  })
})
