process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// P1-5: a draft goods receipt must not move stock. Stock effects post
// exactly once, on the draft -> completed transition — never at create,
// never twice.

const SUFFIX = Date.now()

let location = null
let category = null
let product = null
let adminToken = null

const makePO = async (price, qty = 10) => {
  const res = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: location.id,
      status: 'ordered',
      items: [{ product: product.id, quantity: qty, price }]
    })
  if (res.status !== 201) throw new Error('PO setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

const makeDraftGR = async (po, qtyReceived = 10) => {
  const res = await request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: location.id,
      purchaseOrderId: po.id,
      status: 'draft',
      items: [
        {
          purchaseOrderItem: po.items[0].id,
          product: product.id,
          qtyReceived,
          price: 5000
        }
      ]
    })
  if (res.status !== 201) throw new Error('GR setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function fgStock() {
  return Number((await db.product.findByPk(product.id)).stock)
}

async function poReceived(poId, itemId) {
  const row = await db.purchase_order_item.findByPk(itemId)
  return Number(row.receivedQuantity) || 0
}

async function activeBatches() {
  return db.product_batch.findAll({
    where: { product: product.id, store: location.id, status: 'active' }
  })
}

beforeAll(async () => {
  location = await db.location.create({ name: `GR_DRAFT_STORE_${SUFFIX}`, status: 'active' })
  category = await db.category.create({ name: `GR_DRAFT_CAT_${SUFFIX}` })
  product = await db.product.create({
    nameProduct: `GR_DRAFT_PROD_${SUFFIX}`,
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  await db.user.create({
    id: 7931,
    userName: `admin_gr_draft_${SUFFIX}`,
    email: `admin_gr_draft_${SUFFIX}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'GR_DRAFT_ADMIN'
  })
  adminToken = await signSessionToken(
    { id: 7931, userName: `admin_gr_draft_${SUFFIX}`, roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  // Scoped cleanup only (never a global wipe): parallel suites share this
  // test database, and an unscoped destroy can delete another suite's rows
  // mid-flight — or theirs ours.
  const receiptIds = await db.goodsReceipt
    .findAll({ where: { store: location.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  const poIds = await db.purchase_order
    .findAll({ where: { store: location.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  const batchIds = await db.product_batch
    .findAll({ where: { product: product.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  if (batchIds.length) {
    await db.product_batch_stock.destroy({ where: { batch: batchIds }, force: true })
  }
  await db.product_batch.destroy({ where: { product: product.id }, force: true })
  await db.stock_history.destroy({ where: { product: product.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: location.id }, force: true })
  if (receiptIds.length) {
    await db.goodsReceiptItem.destroy({ where: { goodsReceipt: receiptIds }, force: true })
  }
  await db.goodsReceipt.destroy({ where: { store: location.id }, force: true })
  if (poIds.length) {
    await db.purchase_order_item.destroy({ where: { purchaseOrder: poIds }, force: true })
  }
  await db.purchase_order.destroy({ where: { store: location.id }, force: true })
  await db.best_selling.destroy({ where: { store: location.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.user.destroy({ where: { id: [7931] }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

describe('P1-5 — draft GR posts nothing; completion posts once', () => {
  test('creating a draft moves no stock, creates no batches, touches no PO quantities', async () => {
    const po = await makePO(5000)
    await makeDraftGR(po, 10)

    expect(await fgStock()).toBe(0)
    expect(await poReceived(po.id, po.items[0].id)).toBe(0)
    expect(await activeBatches()).toHaveLength(0)
  })

  test('completing the draft applies the full effect exactly once', async () => {
    const po = await makePO(5000)
    const draft = await makeDraftGR(po, 10)

    const res = await request(app)
      .patch(`/goods-receipt/status/${draft.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed', store: location.id })
    expect(res.status).toBe(200)

    expect(await fgStock()).toBe(10)
    expect(await poReceived(po.id, po.items[0].id)).toBe(10)
    expect(await activeBatches()).toHaveLength(1)

    // Completing again must not double-post (guard rejects non-draft).
    const again = await request(app)
      .patch(`/goods-receipt/status/${draft.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed', store: location.id })
    expect(again.status).not.toBe(200)
    expect(await fgStock()).toBe(10)
  })

  test('cancelling a never-posted draft reverses nothing', async () => {
    const po = await makePO(5000)
    const draft = await makeDraftGR(po, 10)
    const baseline = await fgStock()

    const res = await request(app)
      .patch(`/goods-receipt/status/${draft.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cancelled', store: location.id })
    expect(res.status).toBe(200)
    expect(await fgStock()).toBe(baseline)
  })
})
