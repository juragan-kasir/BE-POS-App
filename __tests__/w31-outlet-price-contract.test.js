process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA = null
let storeB = null
let category = null
let product = null
let optProduct = null
let zeroProduct = null
let tableA = null
let adminToken = null
let adminBToken = null
let cashierToken = null

beforeAll(async () => {
  storeA = await db.location.create({ name: 'W31_STORE_A', status: 'active' })
  storeB = await db.location.create({ name: 'W31_STORE_B', status: 'active' })
  category = await db.category.create({ name: 'W31_CAT' })
  product = await db.product.create({
    nameProduct: 'W31_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100
  })
  optProduct = await db.product.create({
    nameProduct: 'W31_OPT_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100,
    options: [{ name: 'Size', options: [{ name: 'Large', price: 2000 }] }]
  })
  zeroProduct = await db.product.create({
    nameProduct: 'W31_ZERO_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100
  })
  for (const p of [product, optProduct, zeroProduct]) {
    await db.product_store_stock.create({ product: p.id, store: storeA.id, stock: 100 })
    await db.product_store_stock.create({ product: p.id, store: storeB.id, stock: 100 })
    // POS listing only shows store-assigned products; assign to both stores
    // so the listing contract is exercisable (storeB assignment also keeps
    // the isolation test orderable at B with base fallback).
    await db.product_store.create({ product: p.id, store: storeA.id })
    await db.product_store.create({ product: p.id, store: storeB.id })
  }
  tableA = await db.table.create({ store: storeA.id, name: 'W31_TABLE', capacity: 4 })
  // W3-3 (DR-17): PPN is explicit setup — seed so pricing assertions exercise
  // configured tax rather than the setup error.
  for (const s of [storeA, storeB]) {
    await db.taxConfig.create({
      name: `W31_PPN_${s.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: s.id
    })
  }
  await db.user.create({
    id: 9901,
    userName: 'w31_admin',
    email: 'p14-9901-w31@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active',
    fullName: 'w31_admin'
  })
  await db.user.create({
    id: 9902,
    userName: 'w31_kasir',
    email: 'p14-9902-w31@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: storeA.id,
    status: 'active',
    fullName: 'w31_kasir'
  })
  await db.user.create({
    id: 9903,
    userName: 'w31_admin_b',
    email: 'p14-9903-w31@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeB.id,
    status: 'active',
    fullName: 'w31_admin_b'
  })
  adminToken = await signSessionToken(
    { id: 9901, userName: 'w31_admin', roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
  cashierToken = await signSessionToken(
    { id: 9902, userName: 'w31_kasir', roleType: 'kasir', store: storeA.id },
    JWT_SECRET
  )
  adminBToken = await signSessionToken(
    { id: 9903, userName: 'w31_admin_b', roleType: 'admin', store: storeB.id },
    JWT_SECRET
  )
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: storeA.id, user: 9901, status: 'open', openingBalance: 0, openedAt: new Date() })
  await db.cashRegister.create({ store: storeB.id, user: 9903, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: [storeA?.id, storeB?.id].filter(Boolean) }, force: true })
  await db.user.destroy({ where: { id: [9901, 9902, 9903] }, force: true })
  await db.taxConfig.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  await db.product_store_price.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  await db.auditLog.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true,
    __auditMaintenance: true
  })
  await db.product_store.destroy({
    where: { product: [product?.id, optProduct?.id, zeroProduct?.id].filter(Boolean) },
    force: true
  })
  await db.best_selling.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  await db.stock_history.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  for (const p of [product, optProduct, zeroProduct]) {
    await db.product_store_stock.destroy({ where: { product: p?.id }, force: true })
    await db.product.destroy({ where: { id: p?.id }, force: true })
  }
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.table.destroy({ where: { id: tableA?.id }, force: true })
  await db.location.destroy({
    where: { id: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
})

const setOutletPrice = (prodId, storeId, price) =>
  db.product_store_price.upsert({ product: prodId, store: storeId, price })

const clearOutletPrices = () =>
  db.product_store_price.destroy({
    where: { store: [storeA.id, storeB.id] },
    force: true
  })

const counterOrder = (prodId, storeId, token, overrides = {}) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${token}`)
    .send(withIdempotencyKey({
      store: storeId,
      items: [{ product: prodId, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'W3-1',
      ...overrides
    }))

const qrOrder = () =>
  db.table
    .update({ status: 'available' }, { where: { id: tableA.id } })
    .then(() =>
      request(app)
        .post('/order/customer-create')
        .send({
          store: storeA.id,
          tableId: tableA.id,
          customerName: 'W3-1 QR',
          items: [{ productId: product.id, productName: 'W31', quantity: 1 }],
          session: `w31-${Date.now()}-${Math.random()}`
        })
    )

describe('W3-1 outlet price resolver contract (DR-11)', () => {
  test('1. outlet row wins: base 10000 + outlet 12000 persists order_item.price 12000', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await counterOrder(product.id, storeA.id, cashierToken)

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(12000)
  })

  test('2. no outlet row falls back to base product.price', async () => {
    await clearOutletPrices()

    const res = await counterOrder(product.id, storeA.id, cashierToken)

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(10000)
  })

  test('3. explicit outlet 0 wins (zero is valid, not missing)', async () => {
    await clearOutletPrices()
    await setOutletPrice(zeroProduct.id, storeA.id, 0)

    const res = await counterOrder(zeroProduct.id, storeA.id, cashierToken)

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(0)
  })

  test('4. counter and QR resolve the same catalog price', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const counter = await counterOrder(product.id, storeA.id, cashierToken)
    const qr = await qrOrder()

    expect(counter.status).toBe(201)
    expect(qr.status).toBe(201)
    const counterLine = await db.order_item.findOne({ where: { order: counter.body.data.id }, raw: true })
    const qrLine = await db.order_item.findOne({ where: { order: qr.body.data.id }, raw: true })
    expect(Number(counterLine.price)).toBe(12000)
    expect(Number(qrLine.price)).toBe(12000)
    expect(Number(qrLine.price)).toBe(Number(counterLine.price))
  })

  test('5. store isolation: store B never uses store A outlet price', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await counterOrder(product.id, storeB.id, adminBToken)

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(10000)
  })

  test('6. historical line immutable after catalog price change', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await counterOrder(product.id, storeA.id, cashierToken)
    expect(res.status).toBe(201)
    const orderId = res.body.data.id

    await setOutletPrice(product.id, storeA.id, 15000)
    await db.product.update({ price: 20000 }, { where: { id: product.id } })

    const line = await db.order_item.findOne({ where: { order: orderId }, raw: true })
    expect(Number(line.price)).toBe(12000)

    await db.product.update({ price: 10000 }, { where: { id: product.id } })
    await clearOutletPrices()
  })

  test('7. override audit baseline is the outlet-resolved price (12000), not base', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await counterOrder(product.id, storeA.id, adminToken, {
      items: [{ product: product.id, quantity: 1, priceOverride: 15000 }]
    })
    expect(res.status).toBe(201)

    let audit = null
    for (let i = 0; i < 20 && !audit; i++) {
      audit = await db.auditLog.findOne({
        where: {
          entity: 'order',
          entityId: res.body.data.id,
          action: 'update'
        },
        raw: true
      })
      if (!audit) await new Promise((r) => setTimeout(r, 100))
    }
    expect(audit).not.toBeNull()
    expect(audit.description).toMatch(/Price override/)
    expect(Number(audit.oldValues.items[0].catalogPrice)).toBe(12000)
    expect(Number(audit.newValues.items[0].overriddenPrice)).toBe(15000)
  })

  test('8. customer menu effectivePrice matches checkout (outlet, fallback, zero)', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)
    await setOutletPrice(zeroProduct.id, storeA.id, 0)

    const res = await request(app).get(`/order/customer-menu?store=${storeA.id}`)

    expect(res.status).toBe(200)
    const byId = new Map(res.body.data.products.map((p) => [Number(p.id), p]))
    // outlet row wins; legacy price preserved
    expect(Number(byId.get(product.id).effectivePrice)).toBe(12000)
    expect(Number(byId.get(product.id).price)).toBe(10000)
    // explicit zero is a real zero
    expect(Number(byId.get(zeroProduct.id).effectivePrice)).toBe(0)
    // no outlet row falls back to base
    expect(Number(byId.get(optProduct.id).effectivePrice)).toBe(10000)
  })

  test('9. POS listing effectivePrice matches checkout', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await request(app)
      .get('/product/get-product')
      .set('Authorization', `Bearer ${cashierToken}`)

    expect(res.status).toBe(200)
    const row = res.body.data.find((p) => Number(p.id) === Number(product.id))
    expect(row).toBeDefined()
    expect(Number(row.effectivePrice)).toBe(12000)
    expect(Number(row.price)).toBe(10000)
  })

  test('10. option markup applies on top of the outlet-resolved base, unchanged', async () => {
    await clearOutletPrices()
    await setOutletPrice(optProduct.id, storeA.id, 12000)

    const res = await counterOrder(optProduct.id, storeA.id, cashierToken, {
      items: [{ product: optProduct.id, quantity: 1, options: [{ name: 'Large' }] }]
    })

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    // outlet 12000 + Large 2000 — same markup semantics as base 10000 + 2000
    expect(Number(line.price)).toBe(14000)
  })
})
