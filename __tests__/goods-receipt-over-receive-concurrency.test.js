process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 14 (F22-B10-05): goodsReceipt.js create()'s over-delivery
// validation reads `purchase_order_item.receivedQuantity` via a plain,
// unlocked SELECT (`db.purchase_order_item.findAll(...)`, no `lock`) inside
// its own transaction, computes `remaining = maxDeliverable -
// alreadyReceived` against that snapshot, and only afterwards increments
// receivedQuantity atomically. The increment itself never loses data (it's
// a SQL literal expression), but the VALIDATION GATE is a classic
// time-of-check-to-time-of-use race: two concurrent receipts against the
// same PO item can each read the SAME stale receivedQuantity, each
// individually pass the check, and jointly exceed the PO item's allowed
// quantity even though neither request alone was invalid — the same
// "sum-check-then-insert" race class already fixed for concurrent
// Purchase Payments (purchase-payment-flow.test.js).

let store = null
let category = null
let product = null
let adminToken = null

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'GR_OVERRECEIVE_STORE', status: 'active' }))
  category = await db.category.create({ name: 'GR_OVERRECEIVE_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'GR_OVERRECEIVE_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 0 })
  const adminUser = await db.user.create({
    userName: 'admin_gr_overreceive',
    email: 'admin_gr_overreceive@test.com',
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
  const ownReceipts = await db.goodsReceipt.findAll({ where: { store: store.id }, attributes: ['id'] })
  const ownReceiptIds = ownReceipts.map((r) => r.id)
  await db.goodsReceiptItem.destroy({ where: { goodsReceipt: ownReceiptIds }, force: true })
  await db.goodsReceipt.destroy({ where: { store: store.id }, force: true })
  await db.accounting_outbox.destroy({ where: { store: store.id }, force: true })
  await db.journal_entry_line.destroy({ where: {}, force: true })
  await db.journal_entry.destroy({ where: { store: store.id }, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { userName: 'admin_gr_overreceive' }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F22-B10-05 — Goods Receipt over-delivery validation race', () => {
  test('two concurrent receipts that would jointly exceed the PO item quantity: exactly one is accepted', async () => {
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
    // 50 < 100), but together they'd over-receive by 20 — this is the exact
    // race the unlocked read-then-validate-then-increment sequence is
    // vulnerable to.
    const fireGR = (qty) =>
      request(app)
        .post('/goods-receipt/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          store: store.id,
          purchaseOrderId: po.id,
          status: 'completed',
          items: [
            {
              purchaseOrderItem: poItemId,
              product: product.id,
              qtyReceived: qty,
              price: 5000
            }
          ]
        })

    const [resA, resB] = await Promise.all([fireGR(70), fireGR(50)])

    const statuses = [resA.status, resB.status].sort()
    expect(statuses).toEqual([201, 400])

    const poItem = await db.purchase_order_item.findByPk(poItemId)
    expect(Number(poItem.receivedQuantity)).toBeLessThanOrEqual(100)
    // Exactly the successful request's quantity — never the sum of both.
    expect([70, 50]).toContain(Number(poItem.receivedQuantity))
  })
})
