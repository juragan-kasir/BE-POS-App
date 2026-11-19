process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 39 Batch 3 (J1): PUT /goods-receipt/update/:id must produce the same
// financial journal side effect as PATCH /goods-receipt/status/:id when it
// transitions a receipt draft -> completed.
//
// Pre-fix, update() flips the status with no purchase_journal enqueue, so a
// receipt completed through update posts no journal while the equivalent
// status-endpoint transition posts exactly one.

const SUFFIX = Date.now()

let location = null
let category = null
let product = null
let adminToken = null

const makePO = async (price) => {
  const res = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: location.id,
      status: 'ordered',
      items: [{ product: product.id, quantity: 10, price }]
    })
  if (res.status !== 201) throw new Error('PO setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

const makeDraftGR = async (po, qtyReceived = 10, price = 5000) => {
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
          price
        }
      ]
    })
  if (res.status !== 201) throw new Error('GR setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function outboxJobs(receiptId) {
  return db.accounting_outbox.findAll({
    where: { referenceType: 'goods_receipt', referenceId: receiptId },
    order: [['id', 'ASC']]
  })
}

async function journalEntries(receiptId) {
  return db.journal_entry.findAll({
    where: { store: location.id, sourceType: 'purchase', referenceId: receiptId }
  })
}

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: `GR_J1_STORE_${SUFFIX}`, status: 'active' }))
  category = await db.category.create({ name: `GR_J1_CAT_${SUFFIX}` })
  product = await db.product.create({
    nameProduct: `GR_J1_PROD_${SUFFIX}`,
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7801,
    userName: `admin_gr_j1_${SUFFIX}`,
    email: `admin_gr_j1_${SUFFIX}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: `admin_gr_j1_${SUFFIX}`
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7801, userName: `admin_gr_j1_${SUFFIX}`, roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [7801] }, force: true })
  await db.accounting_outbox.destroy({ where: { store: location.id }, force: true })
  await db.journal_entry_line.destroy({ where: {}, force: true })
  await db.journal_entry.destroy({ where: { store: location.id }, force: true })
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
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('Phase 39 Batch 3 (J1) — update draft->completed posts the purchase journal', () => {
  test('TEST 1 — update draft -> completed enqueues exactly one purchase_journal and posts it', async () => {
    const po = await makePO(5000)
    const receipt = await makeDraftGR(po)
    expect(await outboxJobs(receipt.id)).toHaveLength(0)

    // NOTE: only the with-items update path performs the draft->completed
    // transition (metadata-only edits leave status untouched by design) —
    // so the transition under test carries replacement items.
    const updateRes = await request(app)
      .put(`/goods-receipt/update/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'completed',
        items: [
          {
            purchaseOrderItem: po.items[0].id,
            product: product.id,
            qtyReceived: 10,
            price: 5000
          }
        ]
      })
    expect(updateRes.status).toBe(200)
    expect(updateRes.body.data.status).toBe('completed')

    const jobs = await outboxJobs(receipt.id)
    expect(jobs.map((r) => r.jobType)).toEqual(['purchase_journal'])
    expect(jobs[0].status).toBe('posted')
    expect(await journalEntries(receipt.id)).toHaveLength(1)
  })

  test('TEST 2 — update on an already-completed receipt creates no duplicate journal', async () => {
    const po = await makePO(5000)
    const receipt = await makeDraftGR(po)

    const first = await request(app)
      .put(`/goods-receipt/update/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'completed',
        items: [
          {
            purchaseOrderItem: po.items[0].id,
            product: product.id,
            qtyReceived: 10,
            price: 5000
          }
        ]
      })
    expect(first.status).toBe(200)
    expect(await outboxJobs(receipt.id)).toHaveLength(1)

    // Second completion attempt is rejected by the draft guard ...
    const second = await request(app)
      .put(`/goods-receipt/update/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed', notes: 'again' })
    expect(second.status).toBe(400)

    // ... and enqueues nothing further.
    expect(await outboxJobs(receipt.id)).toHaveLength(1)
    expect(await journalEntries(receipt.id)).toHaveLength(1)
  })

  test('TEST 3 — failed update (over-receiving) leaves no journal behind', async () => {
    const po = await makePO(5000)
    const receipt = await makeDraftGR(po)

    const bad = await request(app)
      .put(`/goods-receipt/update/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'completed',
        items: [
          {
            purchaseOrderItem: po.items[0].id,
            product: product.id,
            qtyReceived: 9999,
            price: 5000
          }
        ]
      })
    expect(bad.status).toBe(400)
    expect(await outboxJobs(receipt.id)).toHaveLength(0)
    expect(await journalEntries(receipt.id)).toHaveLength(0)

    const stillDraft = await db.goodsReceipt.findByPk(receipt.id)
    expect(stillDraft.status).toBe('draft')
  })

  test('TEST 4 — update with replacement items -> completed journals the final quantities', async () => {
    const po = await makePO(5000)
    const receipt = await makeDraftGR(po, 10, 5000)

    const updateRes = await request(app)
      .put(`/goods-receipt/update/${receipt.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'completed',
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

    const jobs = await outboxJobs(receipt.id)
    expect(jobs.map((r) => r.jobType)).toEqual(['purchase_journal'])
    expect(jobs[0].payload.items).toEqual([{ costPrice: 5000, qtyReceived: 6 }])
    expect(await journalEntries(receipt.id)).toHaveLength(1)
  })
})
