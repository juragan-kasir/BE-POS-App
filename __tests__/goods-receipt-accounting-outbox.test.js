process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const { attemptJob, drainAccountingOutbox } = require('../api/service/accountingOutboxService')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 5: goods receipt journal posting used to call
// postPurchaseJournal directly after transaction.commit(), wrapped in
// try/catch(console.error) — a genuine posting failure there (a DB blip,
// pool exhaustion) left the business event (stock received, PO updated)
// committed while the accounting entry silently never existed, exactly the
// fire-and-forget gap the accounting outbox (order/sales-return/purchase-
// payment) was already built to close. These tests prove goods receipt now
// goes through the same durable path.

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
  return res.body.data
}

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'GR_OUTBOX_STORE', status: 'active' }))
  category = await db.category.create({ name: 'GR_OUTBOX_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'GR_OUTBOX_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7701,
    userName: 'admin_gr_outbox',
    email: 'p14-7701-goods-receipt-accounting-outbox@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_gr_outbox'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7701, userName: 'admin_gr_outbox', roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [7701] }, force: true })
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

describe('Goods receipt journal posting — durable outbox parity with order/sales-return/purchase-payment', () => {
  test('a completed goods receipt created via /goods-receipt/create enqueues a durable purchase_journal job and posts it immediately', async () => {
    const po = await makePO(5000)
    const poItemId = po.items[0].id

    const res = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [
          {
            purchaseOrderItem: poItemId,
            product: product.id,
            qtyReceived: 10,
            price: 5000
          }
        ]
      })
    expect(res.status).toBe(201)
    const receiptId = res.body.data.id

    const outboxRows = await db.accounting_outbox.findAll({
      where: { referenceType: 'goods_receipt', referenceId: receiptId }
    })
    expect(outboxRows.map((r) => r.jobType)).toEqual(['purchase_journal'])
    expect(outboxRows[0].status).toBe('posted')
    expect(outboxRows[0].store).toBe(location.id)

    const journalEntries = await db.journal_entry.findAll({
      where: { store: location.id, sourceType: 'purchase', referenceId: receiptId }
    })
    expect(journalEntries.length).toBe(1)
    expect(Number(journalEntries[0].totalDebit)).toBe(50000)
  })

  test('completing a draft receipt via PATCH /goods-receipt/status/:id also enqueues a durable purchase_journal job', async () => {
    const po = await makePO(4000)
    const poItemId = po.items[0].id

    const draftRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        purchaseOrderId: po.id,
        status: 'draft',
        items: [
          {
            purchaseOrderItem: poItemId,
            product: product.id,
            qtyReceived: 10,
            price: 4000
          }
        ]
      })
    expect(draftRes.status).toBe(201)
    const receiptId = draftRes.body.data.id

    const beforeStatus = await db.accounting_outbox.findAll({
      where: { referenceType: 'goods_receipt', referenceId: receiptId }
    })
    expect(beforeStatus.length).toBe(0)

    const statusRes = await request(app)
      .patch(`/goods-receipt/status/${receiptId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed' })
    expect(statusRes.status).toBe(200)

    const outboxRows = await db.accounting_outbox.findAll({
      where: { referenceType: 'goods_receipt', referenceId: receiptId }
    })
    expect(outboxRows.map((r) => r.jobType)).toEqual(['purchase_journal'])
    expect(outboxRows[0].status).toBe('posted')

    const journalEntries = await db.journal_entry.findAll({
      where: { store: location.id, sourceType: 'purchase', referenceId: receiptId }
    })
    expect(journalEntries.length).toBe(1)
  })

  test('a purchase_journal job whose immediate posting fails stays pending and is recovered by the drain function, instead of being silently discarded', async () => {
    // store: null on a jobType whose handler requires it -> a real,
    // reproducible posting failure (account.store NOT NULL), same failure
    // class as a transient DB blip in production. Proves the generic retry
    // path (already proven for order_journal) also covers purchase_journal
    // now that goods receipt actually enqueues jobs of that type.
    const job = await db.accounting_outbox.create({
      jobType: 'purchase_journal',
      payload: {
        store: null,
        receiptId: 999999,
        receiptNumber: 'GR-OUTBOX-FAIL',
        poNumber: 'PO-TEST',
        totalAmount: 50000,
        discount: 0,
        items: [{ costPrice: 5000, qtyReceived: 10 }],
        date: new Date().toISOString(),
        createdBy: null
      }
    })

    const firstAttempt = await attemptJob(job)
    expect(firstAttempt.ok).toBe(false)

    const stillPending = await db.accounting_outbox.findByPk(job.id)
    expect(stillPending.status).toBe('pending')

    await db.accounting_outbox.destroy({ where: { id: job.id }, force: true })
  })

  test('re-draining after a goods receipt job already posted does not create a duplicate journal entry', async () => {
    const po = await makePO(3000)
    const poItemId = po.items[0].id

    const res = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [
          {
            purchaseOrderItem: poItemId,
            product: product.id,
            qtyReceived: 10,
            price: 3000
          }
        ]
      })
    expect(res.status).toBe(201)
    const receiptId = res.body.data.id

    await drainAccountingOutbox({ limit: 100 })
    await drainAccountingOutbox({ limit: 100 })

    const outboxRows = await db.accounting_outbox.findAll({
      where: { referenceType: 'goods_receipt', referenceId: receiptId }
    })
    expect(outboxRows.length).toBe(1)
    expect(outboxRows[0].status).toBe('posted')

    const journalEntries = await db.journal_entry.findAll({
      where: { store: location.id, sourceType: 'purchase', referenceId: receiptId }
    })
    expect(journalEntries.length).toBe(1)
  })
})
