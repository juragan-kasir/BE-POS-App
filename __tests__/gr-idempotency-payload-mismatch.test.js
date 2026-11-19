process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-IDEM-1 (goods receipt): same-key retries carrying a different payload
// must not silently replay the winner. Canonical identity = item
// (product/ingredient) + received quantity — prices, batch codes and notes
// are server-derived/secondary and must not cause false mismatch.

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let category = null
let productA = null
let productB = null
let adminToken = null
let po = null
let poItemA = null
let poItemB = null

async function postGR(body) {
  return request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: store.id,
      purchaseOrderId: po.id,
      ...body
    })
}

function lineA(qty, overrides = {}) {
  return {
    purchaseOrderItem: poItemA.id,
    product: productA.id,
    qtyReceived: qty,
    ...overrides
  }
}

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: `GRIDEM_STORE_${Date.now()}`, status: 'active' }))
  category = await db.category.create({ name: `GRIDEM_CAT_${Date.now()}` })
  productA = await db.product.create({
    nameProduct: `GRIDEM_A_${Date.now()}`,
    category: category.id,
    price: 5000,
    stock: 0
  })
  productB = await db.product.create({
    nameProduct: `GRIDEM_B_${Date.now()}`,
    category: category.id,
    price: 7000,
    stock: 0
  })
  const adminUser = await db.user.create({
    userName: `admin_gridem_${Date.now()}`,
    email: `admin_gridem_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  po = await db.purchase_order.create({
    store: store.id,
    supplier: null,
    orderNumber: `GRIDEM-PO-${Date.now()}`,
    totalAmount: 1000000,
    finalAmount: 1000000,
    status: 'ordered'
  })
  poItemA = await db.purchase_order_item.create({
    purchaseOrder: po.id,
    product: productA.id,
    quantity: 100,
    price: 5000,
    receivedQuantity: 0
  })
  poItemB = await db.purchase_order_item.create({
    purchaseOrder: po.id,
    product: productB.id,
    quantity: 100,
    price: 7000,
    receivedQuantity: 0
  })
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { store: store?.id }, force: true })
  await db.goodsReceiptItem.destroy({ where: {}, force: true })
  const receipts = await db.goodsReceipt.findAll({ where: { store: store?.id } })
  for (const r of receipts) {
    await db.accounting_outbox.destroy({
      where: { referenceType: 'goods_receipt', referenceId: r.id },
      force: true
    })
  }
  await db.goodsReceipt.destroy({ where: { store: store?.id }, force: true })
  await db.purchase_order_item.destroy({ where: { purchaseOrder: po?.id }, force: true })
  await db.purchase_order.destroy({ where: { id: po?.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store?.id }, force: true })
  await db.product.destroy({ where: { id: [productA?.id, productB?.id].filter(Boolean) }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

async function grCount(key) {
  return db.goodsReceipt.count({ where: { purchaseOrderId: po.id, idempotencyKey: key } })
}

async function productStock(productId) {
  return Number((await db.product.findByPk(productId)).stock)
}

describe('F-IDEM-1 goods-receipt payload mismatch', () => {
  test('A — same key + same payload replays without duplicating stock', async () => {
    const key = unique('grA')
    const before = await productStock(productA.id)
    const first = await postGR({ idempotencyKey: key, items: [lineA(10)] })
    expect(first.status).toBe(201)

    const retry = await postGR({ idempotencyKey: key, items: [lineA(10)] })
    expect(retry.status).toBe(200)
    expect(retry.body?.data?.id).toBe(first.body?.data?.id)
    expect(await grCount(key)).toBe(1)
    expect(await productStock(productA.id)).toBe(before + 10)
  })

  test('B — same key + different payload is rejected without a second receipt', async () => {
    const key = unique('grB')
    const before = await productStock(productA.id)
    const first = await postGR({ idempotencyKey: key, items: [lineA(10)] })
    expect(first.status).toBe(201)

    const retry = await postGR({
      idempotencyKey: key,
      items: [
        {
          purchaseOrderItem: poItemB.id,
          product: productB.id,
          qtyReceived: 10
        }
      ]
    })
    expect(retry.status).toBe(409)
    expect(await grCount(key)).toBe(1)
    expect(await productStock(productA.id)).toBe(before + 10)
    expect(await productStock(productB.id)).toBe(0)
  })

  test('C — concurrent same-key requests create exactly one receipt', async () => {
    const key = unique('grC')
    const [r1, r2] = await Promise.all([
      postGR({ idempotencyKey: key, items: [lineA(5)] }),
      postGR({ idempotencyKey: key, items: [lineA(5)] })
    ])
    expect([r1.status, r2.status].sort()).toEqual([200, 201])
    expect(await grCount(key)).toBe(1)
  })

  test('D — different keys create independent receipts', async () => {
    const r1 = await postGR({ idempotencyKey: unique('grD1'), items: [lineA(2)] })
    const r2 = await postGR({ idempotencyKey: unique('grD2'), items: [lineA(3)] })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r2.body?.data?.id).not.toBe(r1.body?.data?.id)
  })

  test('E — reordered items and cosmetic fields do not false-mismatch', async () => {
    const key = unique('grE')
    const first = await postGR({
      idempotencyKey: key,
      items: [
        lineA(4, { notes: 'first note' }),
        {
          purchaseOrderItem: poItemB.id,
          product: productB.id,
          qtyReceived: 6,
          batchNumber: 'BATCH-1'
        }
      ]
    })
    expect(first.status).toBe(201)

    const retry = await postGR({
      idempotencyKey: key,
      items: [
        {
          purchaseOrderItem: poItemB.id,
          product: productB.id,
          qtyReceived: 6,
          batchNumber: 'BATCH-2',
          notes: 'different note'
        },
        lineA(4, { notes: 'second note' })
      ]
    })
    expect(retry.status).toBe(200)
    expect(retry.body?.data?.id).toBe(first.body?.data?.id)
  })

  test('F — failed attempt does not poison the key; valid retry succeeds', async () => {
    const key = unique('grF')
    const bad = await postGR({ purchaseOrderId: 999999999, idempotencyKey: key, items: [lineA(1)] })
    expect([400, 404]).toContain(bad.status)

    const good = await postGR({ idempotencyKey: key, items: [lineA(1)] })
    expect(good.status).toBe(201)
    expect(await grCount(key)).toBe(1)
  })
})
