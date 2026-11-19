process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const { attemptJob, drainAccountingOutbox, enqueueAccountingJob } = require('../api/service/accountingOutboxService')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 6: Purchase Return journal posting used to call
// postPurchaseReturnJournal directly after t.commit(), wrapped in
// try/catch(console.error) — the same fire-and-forget gap closed for
// Goods Receipt in Batch 5 (F22-B5-02). A genuine posting failure there
// (a DB blip, pool exhaustion) left the business event (stock restored,
// PO finalAmount reduced) committed while the accounting reversal entry
// silently never existed. These tests prove Purchase Return now goes
// through the same durable outbox path as Order/Sales-Return/Purchase-
// Payment/Goods-Receipt.

let location = null
let category = null
let product = null
let adminToken = null

const receivedPO = async (qty, price) => {
  const poRes = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: location.id,
      status: 'ordered',
      items: [{ product: product.id, quantity: qty, price }]
    })
  const poItemId = poRes.body.data.items[0].id

  await request(app)
    .put(`/purchase-order/receive/${poRes.body.data.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ items: [{ id: poItemId, product: product.id, receivedQuantity: qty }] })

  return poRes.body.data
}

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'PR_OUTBOX_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PR_OUTBOX_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PR_OUTBOX_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 0 })

  const adminUser = await db.user.create({
    userName: 'admin_pr_outbox',
    email: 'admin_pr_outbox@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.accounting_outbox.destroy({ where: { store: location.id }, force: true })
  await db.journal_entry_line.destroy({ where: {}, force: true })
  await db.journal_entry.destroy({ where: { store: location.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.purchase_return_item.destroy({ where: {}, force: true })
  await db.purchase_return.destroy({ where: { store: location.id }, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: { store: location.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { userName: 'admin_pr_outbox' }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('Purchase return journal posting — durable outbox parity with Order/Sales-Return/Purchase-Payment/Goods-Receipt', () => {
  test('enqueueAccountingJob rolls back with its transaction — a rolled-back business event cannot leave an orphaned outbox row', async () => {
    // approve()'s enqueueAccountingJob(..., transaction: t) call sits inside
    // the exact same try{}/t.rollback() shape this test reproduces directly
    // against the real primitive: if anything throws between enqueue and
    // commit, the outbox INSERT rolls back with it. Proven here against
    // the real DB rather than asserted from code reading alone.
    let jobId = null
    await expect(
      db.sequelize.transaction(async (t) => {
        const job = await enqueueAccountingJob({
          jobType: 'purchase_return_journal',
          store: location.id,
          referenceType: 'purchase_return',
          referenceId: 999123,
          payload: {
            store: location.id,
            purchaseReturnId: 999123,
            returnNumber: 'PR-ROLLBACK-PROBE',
            amount: 1000,
            date: new Date().toISOString(),
            createdBy: null
          },
          transaction: t
        })
        jobId = job.id
        throw new Error('forced rollback after enqueue, before commit')
      })
    ).rejects.toThrow('forced rollback after enqueue, before commit')

    const survived = await db.accounting_outbox.findByPk(jobId)
    expect(survived).toBeNull()
  })

  test('approving a purchase return enqueues a durable purchase_return_journal job and posts it immediately', async () => {
    const po = await receivedPO(20, 5000)

    const returnRes = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: po.id,
        reason: 'Damaged goods',
        items: [{ productId: product.id, qty: 6 }]
      })
    expect(returnRes.status).toBe(201)
    const returnId = returnRes.body.data.id

    const approveRes = await request(app)
      .patch(`/purchase-return/approve/${returnId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolution: 'credit' })
    expect(approveRes.status).toBe(200)

    const outboxRows = await db.accounting_outbox.findAll({
      where: { referenceType: 'purchase_return', referenceId: returnId }
    })
    expect(outboxRows.map((r) => r.jobType)).toEqual(['purchase_return_journal'])
    expect(outboxRows[0].status).toBe('posted')
    expect(outboxRows[0].store).toBe(location.id)

    const journalEntries = await db.journal_entry.findAll({
      where: { store: location.id, sourceType: 'purchase_return', referenceId: returnId }
    })
    expect(journalEntries.length).toBe(1)
    expect(Number(journalEntries[0].totalDebit)).toBe(6 * 5000)
  })

  test('a purchase_return_journal job whose immediate posting fails stays pending and is recovered by the drain function, instead of being silently discarded', async () => {
    // store: null on a jobType whose handler requires it -> a real,
    // reproducible posting failure (account.store NOT NULL), same failure
    // class as a transient DB blip in production. Proves the generic retry
    // path (already proven for order_journal / purchase_journal) also
    // covers purchase_return_journal now that Purchase Return actually
    // enqueues jobs of that type.
    const job = await db.accounting_outbox.create({
      jobType: 'purchase_return_journal',
      payload: {
        store: null,
        purchaseReturnId: 999999,
        returnNumber: 'PR-OUTBOX-FAIL',
        amount: 30000,
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

  test('re-draining after a purchase return job already posted does not create a duplicate journal entry', async () => {
    const po = await receivedPO(10, 4000)

    const returnRes = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: po.id,
        reason: 'Wrong item',
        items: [{ productId: product.id, qty: 3 }]
      })
    expect(returnRes.status).toBe(201)
    const returnId = returnRes.body.data.id

    const approveRes = await request(app)
      .patch(`/purchase-return/approve/${returnId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolution: 'credit' })
    expect(approveRes.status).toBe(200)

    await drainAccountingOutbox({ limit: 100 })
    await drainAccountingOutbox({ limit: 100 })

    const outboxRows = await db.accounting_outbox.findAll({
      where: { referenceType: 'purchase_return', referenceId: returnId }
    })
    expect(outboxRows.length).toBe(1)
    expect(outboxRows[0].status).toBe('posted')

    const journalEntries = await db.journal_entry.findAll({
      where: { store: location.id, sourceType: 'purchase_return', referenceId: returnId }
    })
    expect(journalEntries.length).toBe(1)
  })

  test('a second, independently-crafted job for the same purchase return replays the existing journal instead of duplicating it (duplicate-processing / worker-race safety)', async () => {
    const po = await receivedPO(10, 3000)

    const returnRes = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: po.id,
        reason: 'Excess quantity',
        items: [{ productId: product.id, qty: 2 }]
      })
    expect(returnRes.status).toBe(201)
    const returnId = returnRes.body.data.id

    const approveRes = await request(app)
      .patch(`/purchase-return/approve/${returnId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolution: 'credit' })
    expect(approveRes.status).toBe(200)

    const journalBefore = await db.journal_entry.findOne({
      where: { store: location.id, sourceType: 'purchase_return', referenceId: returnId }
    })
    expect(journalBefore).not.toBeNull()

    // A second job for the exact same reference, as if two workers (or an
    // immediate attempt racing a scheduler tick) both tried to post it.
    const duplicateJob = await enqueueAccountingJob({
      jobType: 'purchase_return_journal',
      store: location.id,
      referenceType: 'purchase_return',
      referenceId: returnId,
      payload: {
        store: location.id,
        purchaseReturnId: returnId,
        returnNumber: returnRes.body.data.returnNumber,
        amount: 2 * 3000,
        date: new Date().toISOString(),
        createdBy: null
      }
    })
    const result = await attemptJob(duplicateJob)
    expect(result.ok).toBe(true)
    await db.accounting_outbox.destroy({ where: { id: duplicateJob.id }, force: true })

    const journalEntries = await db.journal_entry.findAll({
      where: { store: location.id, sourceType: 'purchase_return', referenceId: returnId }
    })
    expect(journalEntries.length).toBe(1)
    expect(journalEntries[0].id).toBe(journalBefore.id)
  })

  test('store isolation: a store A purchase return only creates outbox/journal rows scoped to store A', async () => {
    const storeB = await db.location.create(await withTestTenant({ name: 'PR_OUTBOX_STORE_B', status: 'active' }))
    const categoryB = await db.category.create({ name: 'PR_OUTBOX_CATEGORY_B' })
    const productB = await db.product.create({
      nameProduct: 'PR_OUTBOX_PRODUCT_B',
      category: categoryB.id,
      price: 9000,
      costPrice: 6000,
      stock: 0
    })
    await db.product_store_stock.create({ product: productB.id, store: storeB.id, stock: 0 })
    const userB = await db.user.create({
      userName: 'admin_pr_outbox_b',
      email: 'admin_pr_outbox_b@test.com',
      roleType: 'admin',
      userType: 'admin',
      store: storeB.id,
      status: 'active'
    })
    const tokenB = await signSessionToken(
      { id: userB.id, userName: userB.userName, roleType: 'admin', store: storeB.id },
      JWT_SECRET
    )

    try {
      const poResB = await request(app)
        .post('/purchase-order/create')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({
          store: storeB.id,
          status: 'ordered',
          items: [{ product: productB.id, quantity: 5, price: 7000 }]
        })
      const poItemIdB = poResB.body.data.items[0].id
      await request(app)
        .put(`/purchase-order/receive/${poResB.body.data.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ items: [{ id: poItemIdB, product: productB.id, receivedQuantity: 5 }] })

      const returnResB = await request(app)
        .post('/purchase-return/create')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({
          purchaseOrder: poResB.body.data.id,
          reason: 'Store B damaged goods',
          items: [{ productId: productB.id, qty: 2 }]
        })
      expect(returnResB.status).toBe(201)
      const returnIdB = returnResB.body.data.id

      const approveResB = await request(app)
        .patch(`/purchase-return/approve/${returnIdB}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ resolution: 'credit' })
      expect(approveResB.status).toBe(200)

      const outboxRowsB = await db.accounting_outbox.findAll({
        where: { referenceType: 'purchase_return', referenceId: returnIdB }
      })
      expect(outboxRowsB.length).toBe(1)
      expect(outboxRowsB[0].store).toBe(storeB.id)
      expect(outboxRowsB[0].store).not.toBe(location.id)

      const journalEntriesB = await db.journal_entry.findAll({
        where: { sourceType: 'purchase_return', referenceId: returnIdB }
      })
      expect(journalEntriesB.length).toBe(1)
      expect(journalEntriesB[0].store).toBe(storeB.id)

      // Store A's earlier fixtures never leak into Store B's queries.
      const crossStoreLeak = await db.accounting_outbox.findAll({
        where: { store: location.id, referenceType: 'purchase_return', referenceId: returnIdB }
      })
      expect(crossStoreLeak.length).toBe(0)
    } finally {
      await db.accounting_outbox.destroy({ where: { store: storeB.id }, force: true })
      await db.journal_entry_line.destroy({ where: {}, force: true })
      await db.journal_entry.destroy({ where: { store: storeB.id }, force: true })
      await db.stock_history.destroy({ where: { product: productB.id }, force: true })
      await db.product_store_stock.destroy({ where: { product: productB.id }, force: true })
      await db.purchase_return_item.destroy({ where: {}, force: true })
      await db.purchase_return.destroy({ where: { store: storeB.id }, force: true })
      await db.purchase_order_item.destroy({ where: {}, force: true })
      await db.purchase_order.destroy({ where: { store: storeB.id }, force: true })
      await db.product.destroy({ where: { id: productB.id }, force: true })
      await db.category.destroy({ where: { id: categoryB.id }, force: true })
      await db.user.destroy({ where: { id: userB.id }, force: true })
      await db.location.destroy({ where: { id: storeB.id }, force: true })
    }
  })
})
