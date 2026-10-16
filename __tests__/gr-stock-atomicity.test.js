process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-STOCK-1 regression: GR lifecycle stock effects must be exactly-once.
// Established contract (pinned by goods-receipt-reversal-flow.test.js):
// create applies the stock effect for ANY status, update replaces
// (reverse + re-apply), delete reverses. Therefore changeStatus
// draft→completed must NOT re-apply, and draft→cancelled must reverse.

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let category = null
let product = null
let poItemId = null
let poId = null
let adminToken = null

async function makePO() {
  const poRes = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: store.id,
      status: 'ordered',
      items: [{ product: product.id, quantity: 100, price: 5000 }]
    })
  if (poRes.status !== 201) throw new Error('PO setup failed: ' + JSON.stringify(poRes.body))
  return poRes.body.data
}

async function makeDraftGR(qty = 10, key) {
  const res = await request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: store.id,
      purchaseOrderId: poId,
      status: 'draft',
      ...(key ? { idempotencyKey: key } : {}),
      items: [
        {
          purchaseOrderItem: poItemId,
          product: product.id,
          qtyReceived: qty,
          price: 5000
        }
      ]
    })
  if (res.status !== 201) throw new Error('GR setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

beforeAll(async () => {
  store = await db.location.create({ name: `GRAT_STORE_${Date.now()}`, status: 'active' })
  category = await db.category.create({ name: `GRAT_CAT_${Date.now()}` })
  product = await db.product.create({
    nameProduct: `GRAT_PRODUCT_${Date.now()}`,
    category: category.id,
    price: 5000,
    stock: 0
  })
  await db.product_store_stock.create({
    product: product.id,
    store: store.id,
    stock: 0
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7301,
    userName: 'admin_grat',
    email: 'p14-7301-gr-stock-atomicity@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'admin_grat'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7301, userName: 'admin_grat', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  const po = await makePO()
  poId = po.id
  poItemId = po.items[0].id
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.goodsReceiptItem.destroy({ where: {}, force: true })
  const receipts = await db.goodsReceipt.findAll({ where: { store: store?.id } })
  for (const r of receipts) {
    await db.accounting_outbox.destroy({
      where: { referenceType: 'goods_receipt', referenceId: r.id },
      force: true
    })
  }
  await db.goodsReceipt.destroy({ where: { store: store?.id }, force: true })
  await db.purchase_order_item.destroy({ where: { purchaseOrder: poId }, force: true })
  await db.purchase_order.destroy({ where: { id: poId }, force: true })
  // Users last: purchase orders reference the creator (FK).
  await db.user.destroy({ where: { id: [7301] }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

async function productStock() {
  return Number((await db.product.findByPk(product.id)).stock)
}

async function receivedQty() {
  const row = await db.purchase_order_item.findByPk(poItemId)
  return Number(row.receivedQuantity) || 0
}

describe('F-STOCK-1 GR lifecycle exactly-once', () => {
  test('draft→completed posts the stock effect exactly once (nothing at draft)', async () => {
    const baseStock = await productStock()
    const baseReceived = await receivedQty()
    const gr = await makeDraftGR(10, unique('gratC'))
    expect(await productStock()).toBe(baseStock)
    expect(await receivedQty()).toBe(baseReceived)

    const res = await request(app)
      .patch(`/goods-receipt/status/${gr.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed' })
    expect(res.status).toBe(200)

    // Exactly one completion effect — not zero, not doubled.
    // (Later tests capture their own baselines; shared fixtures accrue.)
    expect(await productStock()).toBe(baseStock + 10)
    expect(await receivedQty()).toBe(baseReceived + 10)
  })

  test('draft→cancelled reverses stock and receivedQuantity to baseline', async () => {
    const baseStock = await productStock()
    const baseReceived = await receivedQty()
    const gr = await makeDraftGR(10, unique('gratX'))

    const res = await request(app)
      .patch(`/goods-receipt/status/${gr.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cancelled' })
    expect(res.status).toBe(200)

    expect(await productStock()).toBe(baseStock)
    expect(await receivedQty()).toBe(baseReceived)
  })

  test('metadata-only update (no items) preserves the draft stock effect', async () => {
    const gr = await makeDraftGR(10, unique('gratM'))
    const before = await productStock()
    const res = await request(app)
      .put(`/goods-receipt/update/${gr.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notes: 'metadata touch only' })
    expect(res.status).toBe(200)
    expect(await productStock()).toBe(before)
  })

  test('concurrent double-completion applies the stock effect exactly once', async () => {
    const gr = await makeDraftGR(10, unique('gratD'))
    const before = await productStock()

    const [r1, r2] = await Promise.all([
      request(app)
        .patch(`/goods-receipt/status/${gr.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'completed' }),
      request(app)
        .patch(`/goods-receipt/status/${gr.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'completed' })
    ])
    // One winner completes; the loser sees the terminal state.
    // The winner posts the draft's effect exactly once.
    expect([r1.status, r2.status].sort()).toEqual([200, 400])
    expect(await productStock()).toBe(before + 10)
  })

  test('failed update rolls back stock completely', async () => {
    const gr = await makeDraftGR(10, unique('gratR'))
    const before = await productStock()
    // Absurd over-receive beyond tolerance must 400 with rollback.
    const res = await request(app)
      .put(`/goods-receipt/update/${gr.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            purchaseOrderItem: poItemId,
            product: product.id,
            qtyReceived: 10000,
            price: 5000
          }
        ]
      })
    expect(res.status).toBe(400)
    expect(await productStock()).toBe(before)
  })
})
