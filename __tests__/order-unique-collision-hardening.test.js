// F-04 — regression: the idempotent-replay recovery in createCustomerOrder
// (and createOrder) must only engage for ORDER-HEADER uniqueness constraints
// that a same-intent replay can legitimately explain (the (store,
// idempotencyKey) partial index, plus the orderNumber/publicToken uniques).
// A SequelizeUniqueConstraintError from any other table/constraint (an
// order_item or child-table unique, a future index) must NOT be misread as a
// replay: the audit flagged that swallowing arbitrary unique errors as HTTP
// 200 could mask a real failure with an unrelated order. The invariant pinned
// here: order-header collisions with a same-key winner recover as a replay;
// everything else fails closed (500).
//
// The collision itself is injected by stubbing Order.create to throw a
// SequelizeUniqueConstraintError with the specific Postgres constraint name —
// a real concurrent orderNumber collision is not reproducible on demand at
// the HTTP layer, so the test drives the exact error-shape the catch must
// discriminate.

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

let store = null
let category = null
let product = null
let table = null

const buildUniqueError = (constraint) => {
  const err = new Error(
    `duplicate key value violates unique constraint "${constraint}"`
  )
  err.name = 'SequelizeUniqueConstraintError'
  err.parent = new Error(
    `duplicate key value violates unique constraint "${constraint}"`
  )
  err.parent.constraint = constraint
  err.parent.code = '23505'
  err.fields = { store: String(store.id) }
  return err
}

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'F04_COLLISION_STORE', status: 'active' }))
  category = await db.category.create({ name: 'F04_COLLISION_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'F04_COLLISION_PRODUCT',
    category: category.id,
    price: 12000,
    stock: 50,
    isAvailable: true
  })
  await db.product_store_stock.create({
    product: product.id,
    store: store.id,
    stock: product.stock
  })
  table = await db.table.create({ store: store.id, name: 'F04_COLLISION_TABLE' })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these collision assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'F04_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  const seeded = await db.order.findAll({ where: { store: store.id } })
  for (const o of seeded) {
    await db.order_item.destroy({ where: { order: o.id }, force: true })
    await db.order_status.destroy({ where: { order: o.id }, force: true })
    await db.transaction.destroy({ where: { order: o.id }, force: true })
    await db.order.destroy({ where: { id: o.id }, force: true })
  }
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.table.destroy({ where: { id: table?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F-04 — unique-collision catch is scoped to order-header constraints', () => {
  test('a NON-order unique error is NOT returned as a 200 replay — it fails closed', async () => {
    const key = 'f04-non-order-unique-key'
    const seeded = await db.order.create({
      orderNumber: 'F04-SEED-ORDER',
      store: store.id,
      tableId: table.id,
      status: 'pending',
      paymentStatus: 'unpaid',
      source: 'qr',
      idempotencyKey: key
    })

    // Fast-path idempotency lookup (Order.findOne) returns null so the request
    // proceeds to the create; the create itself then throws the crafted unique
    // error from a CHILD table, which must NOT be recovered as a replay.
    const findOneSpy = jest
      .spyOn(db.order, 'findOne')
      .mockImplementationOnce(() => Promise.resolve(null))
    const createSpy = jest
      .spyOn(db.order, 'create')
      .mockImplementationOnce(() =>
        Promise.reject(buildUniqueError('order_item_sku_unique'))
      )

    const res = await request(app).post('/order/customer-create').send({
      store: store.id,
      tableId: table.id,
      customerName: 'F04 Collision',
      idempotencyKey: key,
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
    })

    findOneSpy.mockRestore()
    createSpy.mockRestore()

    expect(res.status).not.toBe(200)
    expect(res.status).toBe(500)

    await db.order.destroy({ where: { id: seeded.id }, force: true })
  })

  test('a real idempotency-index collision is still recovered as a 200 replay', async () => {
    const key = `f04-idem-key-${Date.now()}`
    const seeded = await db.order.create({
      orderNumber: 'F04-SEED-IDEM',
      store: store.id,
      tableId: table.id,
      status: 'pending',
      paymentStatus: 'unpaid',
      source: 'qr',
      idempotencyKey: key
    })
    // A real same-key winner always carries the retried items — seed the
    // matching row so the replay-vs-mismatch discriminator (F-IDEM-1) sees
    // the same intent the replay below sends. Asserted behavior (200 +
    // winner id) is unchanged.
    await db.order_item.create({
      order: seeded.id,
      product: product.id,
      productName: product.nameProduct,
      quantity: 1,
      price: product.price
    })

    const findOneSpy = jest
      .spyOn(db.order, 'findOne')
      .mockImplementationOnce(() => Promise.resolve(null))
    const createSpy = jest
      .spyOn(db.order, 'create')
      .mockImplementationOnce(() =>
        Promise.reject(buildUniqueError('order_store_idempotencykey_unique'))
      )

    const res = await request(app).post('/order/customer-create').send({
      store: store.id,
      tableId: table.id,
      customerName: 'F04 Idem',
      idempotencyKey: key,
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
    })

    findOneSpy.mockRestore()
    createSpy.mockRestore()

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(seeded.id)

    await db.order.destroy({ where: { id: seeded.id }, force: true })
  })

  test('a same-key orderNumber collision still recovers as a 200 replay (race loser vs winner of the same key)', async () => {
    const key = `f04-ordernum-key-${Date.now()}`
    const seeded = await db.order.create({
      orderNumber: 'F04-SEED-ORDERNUM',
      store: store.id,
      tableId: table.id,
      status: 'pending',
      paymentStatus: 'unpaid',
      source: 'qr',
      idempotencyKey: key
    })
    // Same realistic same-intent fixture as above for the F-IDEM-1
    // replay-vs-mismatch discriminator; asserted behavior unchanged.
    await db.order_item.create({
      order: seeded.id,
      product: product.id,
      productName: product.nameProduct,
      quantity: 1,
      price: product.price
    })

    const findOneSpy = jest
      .spyOn(db.order, 'findOne')
      .mockImplementationOnce(() => Promise.resolve(null))
    const createSpy = jest
      .spyOn(db.order, 'create')
      .mockImplementationOnce(() =>
        Promise.reject(buildUniqueError('order_orderNumber_key'))
      )

    const res = await request(app).post('/order/customer-create').send({
      store: store.id,
      tableId: table.id,
      customerName: 'F04 OrdNum',
      idempotencyKey: key,
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
    })

    findOneSpy.mockRestore()
    createSpy.mockRestore()

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(seeded.id)

    await db.order.destroy({ where: { id: seeded.id }, force: true })
  })
})