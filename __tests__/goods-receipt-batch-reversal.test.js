process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const { Op } = require('sequelize')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 39 Batch 3 (B1): reversing a Goods Receipt must also retire the
// product_batch / product_batch_stock rows its create path produced.
// Pre-fix, reverseStock unwinds product/ingredient stock but leaves the
// receipt's batches active, so FIFO and expiry write-off can later consume
// or write off phantom quantities.

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

const makeDraftGR = async (po, qtyReceived = 10, extraItem = {}) => {
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
          price: 5000,
          ...extraItem
        }
      ]
    })
  if (res.status !== 201) throw new Error('GR setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function receiptBatches(receiptNumber) {
  return db.product_batch.findAll({
    where: {
      product: product.id,
      store: location.id,
      batchCode: { [Op.like]: `${receiptNumber}-%` }
    },
    order: [['id', 'ASC']]
  })
}

async function activeBatches() {
  return db.product_batch.findAll({
    where: { product: product.id, store: location.id, status: 'active' },
    order: [['id', 'ASC']]
  })
}

async function batchStocks(batchId) {
  return db.product_batch_stock.findAll({ where: { batch: batchId } })
}

// P1-5: drafts post nothing — every lifecycle below completes the draft
// first so there is a posted effect (and batches) to reverse/retire.
const completeGR = async (id) => {
  const res = await request(app)
    .patch(`/goods-receipt/status/${id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ status: 'completed', store: location.id })
  if (res.status !== 200) throw new Error('Complete setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

// Reversal paths (cancel/delete/update-rebuild) only unwind posted effects.
// Since new drafts never post, a posted draft is legacy state (posted at
// create before P1-5, or completed-then-reopened): simulate it by flipping
// a completed receipt back to draft — stockPosted stays true, exactly like
// a pre-deploy draft row.
const reopenAsLegacyDraft = async (id) => {
  await db.goodsReceipt.update({ status: 'draft' }, { where: { id } })
}

async function fgStock() {
  return Number((await db.product.findByPk(product.id)).stock)
}

beforeAll(async () => {
  location = await db.location.create({ name: `GR_B1_STORE_${SUFFIX}`, status: 'active' })
  category = await db.category.create({ name: `GR_B1_CAT_${SUFFIX}` })
  product = await db.product.create({
    nameProduct: `GR_B1_PROD_${SUFFIX}`,
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  // P1-4: central gate denies unknown caller identities; the token above
  // must belong to a real row (assertions below are unchanged).
  await db.user.create({
    id: 7901,
    userName: `admin_gr_b1_${SUFFIX}`,
    email: `admin_gr_b1_${SUFFIX}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'GR_B1_ADMIN'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7901, userName: `admin_gr_b1_${SUFFIX}`, roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.product_batch_stock.destroy({ where: {}, force: true })
  await db.product_batch.destroy({ where: { product: product?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.goodsReceiptItem.destroy({ where: {}, force: true })
  await db.goodsReceipt.destroy({ where: { store: location.id }, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: { store: location.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: [7901] }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('Phase 39 Batch 3 (B1) — GR reversal retires its product batches', () => {
  test('TEST 1 — cancel retires the receipt batches: no active batch, zeroed batch stock', async () => {
    const baseline = await fgStock()
    const po = await makePO(5000)
    const receipt = await makeDraftGR(po, 10)
    expect(await fgStock()).toBe(baseline)
    await completeGR(receipt.id)
    expect(await fgStock()).toBe(baseline + 10)

    // Completed receipts are terminal — reopen as a legacy posted draft so
    // the cancel path has a posted effect to unwind.
    await reopenAsLegacyDraft(receipt.id)

    const created = await receiptBatches(receipt.receiptNumber)
    expect(created).toHaveLength(1)
    expect(created[0].status).toBe('active')
    expect(Number(created[0].qty)).toBe(10)

    const cancelRes = await request(app)
      .patch(`/goods-receipt/status/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cancelled' })
    expect(cancelRes.status).toBe(200)
    expect(await fgStock()).toBe(baseline)

    // The receipt's batch must no longer be consumable by FIFO/expiry.
    expect(await activeBatches()).toHaveLength(0)
    const retired = await receiptBatches(receipt.receiptNumber)
    expect(retired).toHaveLength(1)
    expect(retired[0].status).not.toBe('active')
    for (const b of retired) {
      for (const s of await batchStocks(b.id)) {
        expect(Number(s.quantity)).toBe(0)
      }
    }
  })

  test('TEST 2 — update with replacement voids old batches and creates current ones', async () => {
    const baseline = await fgStock()
    const po = await makePO(5000)
    const receipt = await makeDraftGR(po, 10)
    // Still a draft: editing lines moves no stock and creates no batches.
    const updateRes = await request(app)
      .put(`/goods-receipt/update/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'draft',
        items: [
          {
            purchaseOrderItem: po.items[0].id,
            product: product.id,
            qtyReceived: 6,
            price: 5000
          }
        ]
      })
    expect(updateRes.status).toBe(200)
    expect(await fgStock()).toBe(baseline)
    expect(await activeBatches()).toHaveLength(0)

    // Completing posts the final lines: exactly one active batch of 6,
    // with nothing retired (nothing was ever posted before).
    await completeGR(receipt.id)
    expect(await fgStock()).toBe(baseline + 6)
    const all = await receiptBatches(receipt.receiptNumber)
    const active = all.filter((b) => b.status === 'active')
    expect(active).toHaveLength(1)
    expect(Number(active[0].qty)).toBe(6)
    expect(all.filter((b) => b.status !== 'active')).toHaveLength(0)

    // Close the lifecycle: cancelling the replaced receipt unwinds the
    // posted effect and retires the batch.
    await reopenAsLegacyDraft(receipt.id)
    const cancelRes = await request(app)
      .patch(`/goods-receipt/status/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cancelled' })
    expect(cancelRes.status).toBe(200)
    expect(await fgStock()).toBe(baseline)
    expect(await activeBatches()).toHaveLength(0)
  })

  test('TEST 3 — delete retires the receipt batches', async () => {
    const baseline = await fgStock()
    const po = await makePO(5000)
    const receipt = await makeDraftGR(po, 10)
    await completeGR(receipt.id)
    expect(await fgStock()).toBe(baseline + 10)

    // A completed receipt cannot be deleted; reopen as a legacy posted
    // draft so the delete path has a posted effect to unwind.
    await reopenAsLegacyDraft(receipt.id)

    const delRes = await request(app)
      .delete(`/goods-receipt/delete/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(delRes.status).toBe(200)
    expect(await fgStock()).toBe(baseline)
    expect(await activeBatches()).toHaveLength(0)
    const retired = await receiptBatches(receipt.receiptNumber)
    expect(retired).toHaveLength(1)
    expect(retired[0].status).not.toBe('active')
  })

  test('TEST 3b — deleting a never-posted draft removes rows with no stock movement', async () => {
    const baseline = await fgStock()
    const po = await makePO(5000)
    const receipt = await makeDraftGR(po, 10)

    const delRes = await request(app)
      .delete(`/goods-receipt/delete/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(delRes.status).toBe(200)
    expect(await fgStock()).toBe(baseline)
    expect(await activeBatches()).toHaveLength(0)
    expect(await receiptBatches(receipt.receiptNumber)).toHaveLength(0)
  })

  test('TEST 4 — cancelling one receipt never touches another receipt batch', async () => {
    const po = await makePO(5000, 20)
    const receiptA = await makeDraftGR(po, 10, { batchNumber: `B1-LOT-A-${SUFFIX}` })
    const receiptB = await makeDraftGR(po, 10, { batchNumber: `B1-LOT-B-${SUFFIX}` })
    await completeGR(receiptA.id)
    await completeGR(receiptB.id)
    await reopenAsLegacyDraft(receiptA.id)

    const cancelRes = await request(app)
      .patch(`/goods-receipt/status/${receiptA.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cancelled' })
    expect(cancelRes.status).toBe(200)

    const batchA = await db.product_batch.findAll({
      where: { product: product.id, store: location.id, batchCode: `B1-LOT-A-${SUFFIX}` }
    })
    expect(batchA).toHaveLength(1)
    expect(batchA[0].status).not.toBe('active')

    const batchB = await db.product_batch.findAll({
      where: { product: product.id, store: location.id, batchCode: `B1-LOT-B-${SUFFIX}` }
    })
    expect(batchB).toHaveLength(1)
    expect(batchB[0].status).toBe('active')
    expect(Number(batchB[0].qty)).toBe(10)

    // Cleanup the surviving receipt through its own lifecycle.
    await reopenAsLegacyDraft(receiptB.id)
    const cancelB = await request(app)
      .patch(`/goods-receipt/status/${receiptB.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cancelled' })
    expect(cancelB.status).toBe(200)
  })

  test('TEST 5 — repeated cancel is rejected and cannot double-void batches', async () => {
    const po = await makePO(5000)
    const receipt = await makeDraftGR(po, 10)

    const first = await request(app)
      .patch(`/goods-receipt/status/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cancelled' })
    expect(first.status).toBe(200)
    const afterFirst = await receiptBatches(receipt.receiptNumber)

    const second = await request(app)
      .patch(`/goods-receipt/status/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cancelled' })
    expect(second.status).toBe(400)

    const afterSecond = await receiptBatches(receipt.receiptNumber)
    expect(afterSecond.map((b) => [b.id, b.status, Number(b.qty)])).toEqual(
      afterFirst.map((b) => [b.id, b.status, Number(b.qty)])
    )
  })
})
