process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'
// TEST-ONLY configuration: shrink the per-(store, IP) window so the suite
// stays fast and deterministic (each Jest file runs in its own process /
// limiter instance, so this never affects the other suites — production uses
// the CUSTOMER_ORDER_RATE_LIMIT default of 50). The DB is recreated fresh by
// scripts/setup-test-db.js on every run, so order-cardinality is bounded.
process.env.CUSTOMER_ORDER_RATE_LIMIT = '5'

const request = require('supertest')
const crypto = require('crypto')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

// FND-002 (security) — regression coverage for the dedicated rate limiter on
// the anonymous endpoint POST /order/customer-create (see api/routes/order.js:
// customerCreateLimiter). SEC-004 idempotency only dedupes REPLAYS of the same
// (store, idempotencyKey); an attacker can omit idempotencyKey or rotate a
// fresh key per request, so the endpoint needs a volume ceiling of its own.
//
// EVERY test drives the real HTTP route + limiter middleware (no isolated
// unit-level limiter calls), and each test pins its own RFC 5737 TEST-NET-3
// client IP so buckets are never shared accidentally across tests.

const LIMIT = Number(process.env.CUSTOMER_ORDER_RATE_LIMIT)

// RFC 5737 documentation/test addresses — one distinct IP per test scenario.
const IP_BELOW_LIMIT = '203.0.113.11'
const IP_EXCEED = '203.0.113.12'
const IP_UNIQUE_KEYS = '203.0.113.13'
const IP_NO_KEY = '203.0.113.14'
const IP_SHARED = '203.0.113.15'
const IP_CROSS_STORE = '203.0.113.16'
const IP_DIFF_IP_A = '203.0.113.17'
const IP_DIFF_IP_B = '203.0.113.18'
const IP_SEC004 = '203.0.113.19'
const IP_VALIDATION = '203.0.113.20'

let store1 = null
let store2 = null
let category = null
let product = null
const tables = {}
const createdOrderIds = []

const randomKey = (prefix = 'fnd002') =>
  `${prefix}-${crypto.randomBytes(8).toString('hex')}`

// Real HTTP round-trip through the mounted route middleware + limiter.
//
// Phase 39 — a successful QR order now occupies its table, but this suite
// exercises the RATE LIMITER, not table occupancy: many of these tests fire
// several creates in a row against the same shared per-store table on
// purpose (to fill a bucket), and none of them ever pay/cancel their order.
// Resetting the target table to available immediately before every send
// keeps each call independent of the last one's occupancy side effect,
// without touching production behavior.
const customerCreate = async (overrides = {}) => {
  const { store: storeId, ip, noKey = false, key } = overrides
  if (tables[storeId]) {
    await db.table.update({ status: 'available' }, { where: { id: tables[storeId].id } })
  }
  const payload = {
    store: storeId,
    tableId: tables[storeId]?.id,
    items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
  }
  if (!noKey) payload.idempotencyKey = key || randomKey()
  let req = request(app).post('/order/customer-create')
  if (ip) req = req.set('X-Forwarded-For', ip)
  return req.send(payload)
}

const createAccepted = async (overrides) => {
  const res = await customerCreate(overrides)
  if (res.status === 201) createdOrderIds.push(res.body.data.id)
  return res
}

// Fill a (store, ip) bucket to the configured limit, then return the next
// (blocked) response. Every fill request uses a fresh idempotencyKey (or none)
// so only the limiter, never SEC-004, bounds the number of created orders.
const fillBucket = async (storeId, ip, { noKey = false } = {}) => {
  for (let i = 0; i < LIMIT; i++) {
    const res = await createAccepted({ store: storeId, ip, noKey })
    expect(res.status).toBe(201)
  }
  return customerCreate({ store: storeId, ip, noKey })
}

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({ name: 'FND002_STORE_1', status: 'active' }))
  store2 = await db.location.create(await withTestTenant({ name: 'FND002_STORE_2', status: 'active' }))
  category = await db.category.create({ name: 'FND002_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'FND002_PRODUCT',
    category: category.id,
    price: 12000,
    stock: 50,
    isAvailable: true
  })
  // Explicit product_store assignment (both stores) so store tenancy is real:
  // an unassigned store (e.g. 999999) must be rejected by the controller's
  // AUD-2 check instead of falling through the "no assignments" legacy path.
  await db.product_store.create({ product: product.id, store: store1.id })
  await db.product_store.create({ product: product.id, store: store2.id })
  await db.product_store_stock.create({
    product: product.id,
    store: store1.id,
    stock: product.stock
  })
  await db.product_store_stock.create({
    product: product.id,
    store: store2.id,
    stock: product.stock
  })
  tables[store1.id] = await db.table.create({ store: store1.id, name: 'FND002_TABLE_1' })
  tables[store2.id] = await db.table.create({ store: store2.id, name: 'FND002_TABLE_2' })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed rates for
  // both stores so QR setup assertions exercise configured tax.
  for (const s of [store1, store2]) {
    await db.taxConfig.create({
      name: `FND002_PPN_${s.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: s.id
    })
  }
})

afterAll(async () => {
  await db.taxConfig.destroy({
    where: { store: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
  for (const id of createdOrderIds) {
    await db.order_item.destroy({ where: { order: id }, force: true })
    await db.order_status.destroy({ where: { order: id }, force: true })
    await db.transaction.destroy({ where: { order: id }, force: true })
    await db.order.destroy({ where: { id }, force: true })
  }
  await db.product_store.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.table.destroy({
    where: { id: Object.values(tables).map((t) => t.id).filter(Boolean) },
    force: true
  })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.best_selling.destroy({ where: { productId: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
})

describe('FND-002 — customer-create rate limiter (POST /order/customer-create)', () => {
  test('legitimate small burst below the configured limit succeeds', async () => {
    const ip = IP_BELOW_LIMIT
    for (let i = 0; i < 3; i++) {
      const res = await createAccepted({ store: store1.id, ip })
      expect(res.status).toBe(201)
      // orders are created as pending/unpaid (AUD-1) — the limiter must not
      // change the normalized QR order state.
      expect(res.body.data.paymentStatus).toBe('unpaid')
    }
  })

  test('requests exceeding the configured limit receive HTTP 429', async () => {
    const ip = IP_EXCEED
    const blocked = await fillBucket(store1.id, ip)
    expect(blocked.status).toBe(429)
    expect(blocked.body).toEqual({
      success: false,
      message: 'Too many requests, please try again later.'
    })
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
  })

  test('rotating unique idempotencyKey values does NOT bypass the limiter', async () => {
    // fillBucket sends a brand-new key on every request — SEC-004 cannot help
    // here, only the volume ceiling can stop this.
    const blocked = await fillBucket(store1.id, IP_UNIQUE_KEYS)
    expect(blocked.status).toBe(429)
  })

  test('omitting idempotencyKey does NOT bypass the limiter', async () => {
    const blocked = await fillBucket(store1.id, IP_NO_KEY, { noKey: true })
    expect(blocked.status).toBe(429)
  })

  test('same store + same client IP share a single bucket', async () => {
    const ip = IP_SHARED
    // Mix of keyed and unkeyed requests — all must draw from the SAME bucket,
    // so the 6th request is blocked regardless of whether a key was sent.
    for (let i = 0; i < LIMIT; i++) {
      const res = await createAccepted({
        store: store1.id,
        ip,
        noKey: i % 2 === 1,
        key: i % 2 === 0 ? `shared-key-${i}` : undefined
      })
      expect(res.status).toBe(201)
    }
    const blocked = await customerCreate({ store: store1.id, ip, noKey: true })
    expect(blocked.status).toBe(429)
  })

  test('the same client IP has an independent bucket per store', async () => {
    const ip = IP_CROSS_STORE
    // Exhaust the store1 bucket (5 creates + 1 blocked).
    const blockedAtStore1 = await fillBucket(store1.id, ip)
    expect(blockedAtStore1.status).toBe(429)
    // The store2 bucket is untouched even though it is the same IP.
    const res = await createAccepted({ store: store2.id, ip })
    expect(res.status).toBe(201)
  })

  test('different client IPs at the same store have independent buckets', async () => {
    const blockedA = await fillBucket(store1.id, IP_DIFF_IP_A)
    expect(blockedA.status).toBe(429)
    // A different IP at the same store still has a fresh bucket.
    const res = await createAccepted({ store: store1.id, ip: IP_DIFF_IP_B })
    expect(res.status).toBe(201)
  })

  test('SEC-004 same-idempotencyKey deduplication still works under the limiter', async () => {
    const ip = IP_SEC004
    const idem = `fnd002-sec004-${crypto.randomBytes(8).toString('hex')}`
    const [a, b] = await Promise.all([
      customerCreate({ store: store1.id, ip, key: idem }),
      customerCreate({ store: store1.id, ip, key: idem })
    ])

    // Exactly one fresh create (201) and one replay (200) — the limiter must
    // count the requests but never prevent the idempotent replay itself.
    expect([a.status, b.status].sort()).toEqual([200, 201])
    expect(a.body.data.id).toBe(b.body.data.id)
    createdOrderIds.push((a.status === 201 ? a : b).body.data.id)

    const orderCount = await db.order.count({
      where: { store: store1.id, idempotencyKey: idem }
    })
    expect(orderCount).toBe(1)
  })

  test('existing customer-create validation/security behavior remains intact', async () => {
    const ip = IP_VALIDATION

    // Unknown store → product tenancy (AUD-2) rejects before any order write,
    // whether the id is numeric or a well-formed numeric string.
    const badStore = await customerCreate({ store: 999999, ip, key: randomKey() })
    expect(badStore.status).toBe(400)
    const badStoreStr = await customerCreate({ store: '123', ip, key: randomKey() })
    expect(badStoreStr.status).toBe(400)

    // Missing items → validation rejects.
    const noItems = await request(app)
      .post('/order/customer-create')
      .set('X-Forwarded-For', ip)
      .send({ store: store1.id, idempotencyKey: randomKey() })
    expect(noItems.status).toBe(400)

    // A non-numeric store value can never mint an order. (Pre-existing quirk:
    // the controller's idempotency lookup 500s on a non-numeric store — a
    // non-FND-002 wart, out of scope — but it still writes NO order, so the
    // limiter's 'invalid:<ip>' bucket and this assertion both hold.)
    const malformedStore = await customerCreate({
      store: 'garbage',
      ip,
      key: randomKey()
    })
    expect(malformedStore.status >= 400).toBe(true)
    expect(malformedStore.body?.data).toBeFalsy()
  })
})