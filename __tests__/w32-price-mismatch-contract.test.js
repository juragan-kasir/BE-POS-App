process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

const PRICE_CHANGED_MESSAGE =
  'One or more item prices changed. Please review the updated prices and resubmit.'

let storeA = null
let storeB = null
let category = null
let product = null
let optProduct = null
let zeroProduct = null
let bundle = null
let tableA = null
let adminToken = null
let adminBToken = null
let cashierToken = null

beforeAll(async () => {
  storeA = await db.location.create({ name: 'W32_STORE_A', status: 'active' })
  storeB = await db.location.create({ name: 'W32_STORE_B', status: 'active' })
  category = await db.category.create({ name: 'W32_CAT' })
  product = await db.product.create({
    nameProduct: 'W32_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100
  })
  optProduct = await db.product.create({
    nameProduct: 'W32_OPT_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100,
    options: [{ name: 'Size', options: [{ name: 'Large', price: 2000 }] }]
  })
  zeroProduct = await db.product.create({
    nameProduct: 'W32_ZERO_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100
  })
  for (const p of [product, optProduct, zeroProduct]) {
    await db.product_store_stock.create({ product: p.id, store: storeA.id, stock: 100 })
    await db.product_store_stock.create({ product: p.id, store: storeB.id, stock: 100 })
    await db.product_store.create({ product: p.id, store: storeA.id })
    await db.product_store.create({ product: p.id, store: storeB.id })
  }
  // Bundle is store-assigned so it is orderable on both counter and QR paths.
  bundle = await db.product_bundle.create({
    name: 'W32_BUNDLE',
    bundlePrice: 5000,
    isAvailable: true,
    status: 'active',
    store: storeA.id
  })
  await db.product_bundle_item.create({ bundleId: bundle.id, product: product.id, quantity: 1 })
  tableA = await db.table.create({ store: storeA.id, name: 'W32_TABLE', capacity: 4 })
  // W3-3 (DR-17): PPN is explicit setup — seed so totals compute.
  for (const s of [storeA, storeB]) {
    await db.taxConfig.create({
      name: `W32_PPN_${s.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: s.id
    })
  }
  await db.user.create({
    id: 9911,
    userName: 'w32_admin',
    email: 'p14-9911-w32@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active',
    fullName: 'w32_admin'
  })
  await db.user.create({
    id: 9912,
    userName: 'w32_kasir',
    email: 'p14-9912-w32@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: storeA.id,
    status: 'active',
    fullName: 'w32_kasir'
  })
  await db.user.create({
    id: 9913,
    userName: 'w32_admin_b',
    email: 'p14-9913-w32@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeB.id,
    status: 'active',
    fullName: 'w32_admin_b'
  })
  adminToken = await signSessionToken(
    { id: 9911, userName: 'w32_admin', roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
  cashierToken = await signSessionToken(
    { id: 9912, userName: 'w32_kasir', roleType: 'kasir', store: storeA.id },
    JWT_SECRET
  )
  adminBToken = await signSessionToken(
    { id: 9913, userName: 'w32_admin_b', roleType: 'admin', store: storeB.id },
    JWT_SECRET
  )
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: storeA.id, user: 9911, status: 'open', openingBalance: 0, openedAt: new Date() })
  await db.cashRegister.create({ store: storeB.id, user: 9913, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: [storeA?.id, storeB?.id].filter(Boolean) }, force: true })
  await db.user.destroy({ where: { id: [9911, 9912, 9913] }, force: true })
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
  await db.product_bundle_item.destroy({ where: { bundleId: bundle?.id }, force: true })
  await db.product_bundle.destroy({ where: { id: bundle?.id }, force: true })
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

const counterOrder = (items, storeId, token, overrides = {}) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${token}`)
    .send(withIdempotencyKey({
      store: storeId,
      items,
      paymentMethod: 'cash',
      cashierName: 'W3-2',
      ...overrides
    }))

const qrOrder = (items, overrides = {}) =>
  db.table
    .update({ status: 'available' }, { where: { id: tableA.id } })
    .then(() =>
      request(app)
        .post('/order/customer-create')
        .send({
          store: storeA.id,
          tableId: tableA.id,
          customerName: 'W3-2 QR',
          items,
          session: `w32-${Date.now()}-${Math.random()}`,
          ...overrides
        })
    )

const countWrites = async () => ({
  orders: await db.order.count(),
  items: await db.order_item.count(),
  payments: await db.transaction.count(),
  statuses: await db.order_status.count()
})

describe('W3-2 checkout price-mismatch contract', () => {
  test('A1. counter outlet match → 201, persisted price is the server value', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await counterOrder(
      [{ product: product.id, quantity: 1, expectedPrice: 12000 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(12000)
  })

  test('A2. counter base fallback match → 201', async () => {
    await clearOutletPrices()

    const res = await counterOrder(
      [{ product: product.id, quantity: 1, expectedPrice: 10000 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(10000)
  })

  test('A3. counter explicit outlet 0 match → 201', async () => {
    await clearOutletPrices()
    await setOutletPrice(zeroProduct.id, storeA.id, 0)

    const res = await counterOrder(
      [{ product: zeroProduct.id, quantity: 1, expectedPrice: 0 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(0)
  })

  test('A4. QR outlet match → 201', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await qrOrder([
      { productId: product.id, productName: 'W32', quantity: 1, expectedPrice: 12000 }
    ])

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(12000)
  })

  test('A5. QR base fallback match → 201', async () => {
    await clearOutletPrices()

    const res = await qrOrder([
      { productId: product.id, productName: 'W32', quantity: 1, expectedPrice: 10000 }
    ])

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(10000)
  })

  test('A6. QR explicit outlet 0 match → 201', async () => {
    await clearOutletPrices()
    await setOutletPrice(zeroProduct.id, storeA.id, 0)

    const res = await qrOrder([
      { productId: zeroProduct.id, productName: 'W32Z', quantity: 1, expectedPrice: 0 }
    ])

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(0)
  })

  test('B1. counter base-expected vs outlet current → exact 409, zero writes', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)
    const before = await countWrites()

    const res = await counterOrder(
      [{ product: product.id, quantity: 1, expectedPrice: 10000 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PRICE_CHANGED')
    expect(res.body.message).toBe(PRICE_CHANGED_MESSAGE)
    expect(res.body.items).toEqual([
      { index: 0, productId: product.id, expectedPrice: 10000, currentPrice: 12000 }
    ])
    expect(Object.keys(res.body).sort()).toEqual(['code', 'items', 'message'])
    expect(await countWrites()).toEqual(before)
  })

  test('B2. counter outlet-expected changed → 409', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 15000)

    const res = await counterOrder(
      [{ product: product.id, quantity: 1, expectedPrice: 12000 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PRICE_CHANGED')
    expect(res.body.items).toEqual([
      { index: 0, productId: product.id, expectedPrice: 12000, currentPrice: 15000 }
    ])
  })

  test('B3. QR expected lower than current → 409, zero writes', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)
    const before = await countWrites()

    const res = await qrOrder([
      { productId: product.id, productName: 'W32', quantity: 1, expectedPrice: 9000 }
    ])

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PRICE_CHANGED')
    expect(res.body.message).toBe(PRICE_CHANGED_MESSAGE)
    expect(res.body.items).toEqual([
      { index: 0, productId: product.id, expectedPrice: 9000, currentPrice: 12000 }
    ])
    expect(await countWrites()).toEqual(before)
  })

  test('B4. QR expected higher than current → 409 and never persists the higher price', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const bad = await qrOrder([
      { productId: product.id, productName: 'W32', quantity: 1, expectedPrice: 99999 }
    ])
    expect(bad.status).toBe(409)

    const good = await qrOrder([
      { productId: product.id, productName: 'W32', quantity: 1, expectedPrice: 12000 }
    ])
    expect(good.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: good.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(12000)
  })

  test('C1. option-inclusive expectedPrice matches (outlet 12000 + Large 2000)', async () => {
    await clearOutletPrices()
    await setOutletPrice(optProduct.id, storeA.id, 12000)

    const res = await counterOrder(
      [{ product: optProduct.id, quantity: 1, options: [{ name: 'Large' }], expectedPrice: 14000 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(14000)
  })

  test('C2. stale catalog-only expectation on option line → 409 with marked-up currentPrice', async () => {
    await clearOutletPrices()
    await setOutletPrice(optProduct.id, storeA.id, 12000)

    const res = await counterOrder(
      [{ product: optProduct.id, quantity: 1, options: [{ name: 'Large' }], expectedPrice: 12000 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(409)
    expect(res.body.items).toEqual([
      { index: 0, productId: optProduct.id, expectedPrice: 12000, currentPrice: 14000 }
    ])
  })

  test('D1. multiple mismatches in one 409, request order preserved', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)
    await setOutletPrice(zeroProduct.id, storeA.id, 0)

    const res = await counterOrder(
      [
        { product: product.id, quantity: 1, expectedPrice: 10000 },
        { product: optProduct.id, quantity: 1, expectedPrice: 10000 },
        { product: zeroProduct.id, quantity: 1, expectedPrice: 10000 }
      ],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PRICE_CHANGED')
    expect(res.body.items).toEqual([
      { index: 0, productId: product.id, expectedPrice: 10000, currentPrice: 12000 },
      { index: 2, productId: zeroProduct.id, expectedPrice: 10000, currentPrice: 0 }
    ])
  })

  test('D2. duplicate product lines distinguished by index', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await counterOrder(
      [
        { product: product.id, quantity: 1, expectedPrice: 12000 },
        { product: product.id, quantity: 2, expectedPrice: 10000 }
      ],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(409)
    expect(res.body.items).toEqual([
      { index: 1, productId: product.id, expectedPrice: 10000, currentPrice: 12000 }
    ])
  })

  test('E1. bundle match → 201 at bundlePrice', async () => {
    await clearOutletPrices()

    const res = await counterOrder(
      [{ product: product.id, bundleId: bundle.id, bundleName: 'W32_BUNDLE', quantity: 1, expectedPrice: 5000 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(5000)
    expect(Number(line.bundleId)).toBe(bundle.id)
  })

  test('E2. bundle mismatch → 409 with bundleId, never productId', async () => {
    await clearOutletPrices()

    const res = await counterOrder(
      [{ product: product.id, bundleId: bundle.id, bundleName: 'W32_BUNDLE', quantity: 1, expectedPrice: 4000 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PRICE_CHANGED')
    expect(res.body.items).toEqual([
      { index: 0, bundleId: bundle.id, expectedPrice: 4000, currentPrice: 5000 }
    ])
    expect(res.body.items[0]).not.toHaveProperty('productId')
  })

  test('E3. bundle ignores outlet product pricing', async () => {
    await clearOutletPrices()
    // Outlet row on the bundle component must not move the bundle price.
    await setOutletPrice(product.id, storeA.id, 99999)

    const res = await counterOrder(
      [{ product: product.id, bundleId: bundle.id, bundleName: 'W32_BUNDLE', quantity: 1, expectedPrice: 5000 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(5000)
  })

  test('F1. omitted expectedPrice keeps legacy counter behavior', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await counterOrder(
      [{ product: product.id, quantity: 1 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(12000)
  })

  test('F2. omitted expectedPrice keeps legacy QR behavior', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await qrOrder([
      { productId: product.id, productName: 'W32', quantity: 1 }
    ])

    expect(res.status).toBe(201)
  })

  test('F3. legacy FE-shaped payload (price/basePrice/subtotal, no expectedPrice) → 201', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await counterOrder(
      [
        {
          product: product.id,
          productName: 'W32_PRODUCT',
          quantity: 1,
          price: 10000,
          basePrice: 10000,
          subtotal: 10000,
          options: [],
          modifiers: []
        }
      ],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(12000)
  })

  test('F4. legacy BISA-shaped payload (price + options, no expectedPrice) → 201', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await qrOrder([
      {
        productId: product.id,
        productName: 'W32_PRODUCT',
        quantity: 1,
        price: 10000,
        options: [{ name: 'Size - Large', value: 'Large' }],
        modifiers: []
      }
    ])

    // 'Size - Large' does not match this product's options; server price stays
    // catalog-resolved and the absent expectedPrice skips enforcement.
    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(12000)
  })

  test('G1. manipulated lower expectedPrice never persists', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const bad = await counterOrder(
      [{ product: product.id, quantity: 1, expectedPrice: 1 }],
      storeA.id,
      cashierToken
    )
    expect(bad.status).toBe(409)

    const good = await counterOrder(
      [{ product: product.id, quantity: 1, expectedPrice: 12000 }],
      storeA.id,
      cashierToken
    )
    expect(good.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: good.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(12000)
  })

  test('G2. cross-store isolation: store B uses base while store A has outlet row', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const matchBase = await counterOrder(
      [{ product: product.id, quantity: 1, expectedPrice: 10000 }],
      storeB.id,
      adminBToken
    )
    expect(matchBase.status).toBe(201)

    const staleOutlet = await counterOrder(
      [{ product: product.id, quantity: 1, expectedPrice: 12000 }],
      storeB.id,
      adminBToken
    )
    expect(staleOutlet.status).toBe(409)
    expect(staleOutlet.body.items).toEqual([
      { index: 0, productId: product.id, expectedPrice: 12000, currentPrice: 10000 }
    ])
  })

  test('G3. QR priceOverride + expectedPrice remains 403', async () => {
    await clearOutletPrices()

    const res = await qrOrder([
      {
        productId: product.id,
        productName: 'W32',
        quantity: 1,
        priceOverride: 5000,
        expectedPrice: 10000
      }
    ])

    expect(res.status).toBe(403)
  })

  test('G4. counter non-admin override + expectedPrice remains 403', async () => {
    await clearOutletPrices()

    const res = await counterOrder(
      [{ product: product.id, quantity: 1, priceOverride: 5000, expectedPrice: 10000 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(403)
  })

  test('G5. admin override applies and is exempt from comparison', async () => {
    await clearOutletPrices()
    await setOutletPrice(product.id, storeA.id, 12000)

    const res = await counterOrder(
      [{ product: product.id, quantity: 1, priceOverride: 15000, expectedPrice: 10000 }],
      storeA.id,
      adminToken
    )

    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id }, raw: true })
    expect(Number(line.price)).toBe(15000)
  })

  test('J1. counter rejects decimal expectedPrice with 400', async () => {
    await clearOutletPrices()

    const res = await counterOrder(
      [{ product: product.id, quantity: 1, expectedPrice: 10000.5 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(400)
  })

  test('J2. counter rejects negative expectedPrice with 400', async () => {
    await clearOutletPrices()

    const res = await counterOrder(
      [{ product: product.id, quantity: 1, expectedPrice: -1 }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(400)
  })

  test('J3. counter rejects non-numeric expectedPrice with 400', async () => {
    await clearOutletPrices()

    const res = await counterOrder(
      [{ product: product.id, quantity: 1, expectedPrice: 'abc' }],
      storeA.id,
      cashierToken
    )

    expect(res.status).toBe(400)
  })

  test('J4. QR rejects invalid expectedPrice with 400', async () => {
    await clearOutletPrices()

    for (const expectedPrice of [99.5, -1, 'abc']) {
      const res = await qrOrder([
        { productId: product.id, productName: 'W32', quantity: 1, expectedPrice }
      ])
      expect(res.status).toBe(400)
    }
  })
})
