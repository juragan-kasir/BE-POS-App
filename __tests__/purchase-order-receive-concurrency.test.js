process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 18 (deferred: legacy purchaseOrder.js receive() read ->
// validate/clamp concurrency race): receive() loads `purchaseOrder.items`
// (including each item's receivedQuantity) via a plain, unlocked
// `db.purchase_order.findOne(...)` BEFORE its own transaction even opens
// (line ~866-869, transaction opens at line ~909). Inside the transaction,
// `maxReceive = poItem.quantity - poItem.receivedQuantity` and
// `receiveQty = Math.min(requested, maxReceive)` are computed from that
// pre-transaction, unlocked snapshot — never re-read with a lock. The
// function DOES already lock `product`/`ingredient` rows
// (transaction.LOCK.UPDATE) for the stock-mutation side, but never the
// purchase_order_item row that the clamp itself depends on. Two concurrent
// receive() calls against the same PO item can both read the same stale
// receivedQuantity, both independently compute an apparently-valid
// (clamped) receiveQty, and jointly over-receive — the same race class
// already fixed for Goods Receipt (Batch 14) and Purchase Return
// (Batch 15), confirmed still present here since receive() is a distinct,
// unrelated code path in a different file.

let store = null
let category = null
let product = null
let adminToken = null

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'PO_RECEIVE_RACE_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PO_RECEIVE_RACE_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PO_RECEIVE_RACE_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 0 })
  const adminUser = await db.user.create({
    userName: 'admin_po_receive_race',
    email: 'admin_po_receive_race@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  await db.product_batch_stock.destroy({ where: {}, force: true })
  await db.product_batch.destroy({ where: {}, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { userName: 'admin_po_receive_race' }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('Legacy purchaseOrder.js receive() — over-receive validation race', () => {
  test('two concurrent receive() calls that would jointly exceed the ordered quantity: the combined result is correctly clamped, never exceeding the ordered quantity', async () => {
    const poRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        status: 'ordered',
        overDeliveryTolerance: 0,
        items: [{ product: product.id, quantity: 100, price: 5000 }]
      })
    expect(poRes.status).toBe(201)
    const po = poRes.body.data
    const poItemId = po.items[0].id

    // Each individually fits under the 100-unit ordered quantity (70 < 100,
    // 50 < 100), but together they'd over-receive by 20 — the exact race
    // the unlocked pre-transaction read-then-clamp sequence is vulnerable
    // to. receive() clamps rather than rejects, so both calls should
    // return 200 either way — the invariant under test is the FINAL
    // persisted receivedQuantity, not the HTTP status.
    const fireReceive = (qty) =>
      request(app)
        .put(`/purchase-order/receive/${po.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ items: [{ id: poItemId, product: product.id, receivedQuantity: qty }] })

    const [resA, resB] = await Promise.all([fireReceive(70), fireReceive(50)])

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)

    const poItem = await db.purchase_order_item.findByPk(poItemId)
    // Correctly clamped: whichever request's transaction commits first
    // gets its full (or clamped) amount; the second, once it re-reads the
    // now-current state, is clamped to exactly what's actually left — the
    // combined total converges to exactly the ordered quantity (100), not
    // the naive stale-clamped sum (120).
    expect(Number(poItem.receivedQuantity)).toBe(100)

    // Stock must match the same correctly-clamped total, not the
    // over-received sum — no duplicate/phantom stock increase.
    const freshProduct = await db.product.findByPk(product.id)
    expect(Number(freshProduct.stock)).toBe(100)
  })
})
