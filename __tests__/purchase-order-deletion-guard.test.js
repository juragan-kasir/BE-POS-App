process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 17 (F22-B10-08): purchaseOrder.js delete()'s only guard
// blocked status === 'received' — a PO at 'ordered' (already has real
// goods received against it, tracked via receivedQuantity > 0) was still
// deletable. delete() soft-deletes every purchase_order_item row for the
// PO, then soft-deletes the PO itself. Because goodsReceipt/
// goodsReceiptItem rows are never touched by delete() (they survive), but
// default-scoped queries exclude paranoid soft-deleted rows, this orphans
// the existing GR's ability to resolve its own PO/PO-item lineage
// (e.g. Batch 11's calculatePurchaseOrderFulfillmentStatus, or a later
// Purchase Return's item-matching, both query purchase_order_item without
// paranoid:false). The fix mirrors Batch 16's exact pattern: block the
// destructive path once any existing item already has receivedQuantity >
// 0, regardless of the PO's current status label (this also protects a
// PO that was cancelled while 'ordered' with partial receiving still on
// record, since cancel()'s non-'received' branch never reverses
// receivedQuantity).

let store = null
let category = null
let product = null
let adminToken = null

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'PO_DELETE_GUARD_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PO_DELETE_GUARD_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PO_DELETE_GUARD_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 0 })
  const adminUser = await db.user.create({
    userName: 'admin_po_delete_guard',
    email: 'admin_po_delete_guard@test.com',
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
  await db.user.destroy({ where: { userName: 'admin_po_delete_guard' }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F22-B10-08 — Purchase Order deletion is blocked once real receiving has happened', () => {
  test('DELETE is rejected for an "ordered" PO with a partially-received item, and the PO/item/GR lineage survives intact', async () => {
    const poRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        status: 'ordered',
        items: [{ product: product.id, quantity: 100, price: 5000 }]
      })
    expect(poRes.status).toBe(201)
    const po = poRes.body.data
    const poItemId = po.items[0].id

    const grRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [{ purchaseOrderItem: poItemId, product: product.id, qtyReceived: 40, price: 5000 }]
      })
    expect(grRes.status).toBe(201)
    const grId = grRes.body.data.id

    const freshPo = await db.purchase_order.findByPk(po.id)
    expect(freshPo.status).toBe('ordered')

    const deleteRes = await request(app)
      .delete(`/purchase-order/delete/${po.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(deleteRes.status).toBe(400)

    // PO itself must survive, not soft-deleted.
    const poAfter = await db.purchase_order.findByPk(po.id, { paranoid: false })
    expect(poAfter).not.toBeNull()
    expect(poAfter.deletedAt).toBeNull()

    // PO item must survive, not soft-deleted, receivedQuantity intact.
    const itemAfter = await db.purchase_order_item.findByPk(poItemId, { paranoid: false })
    expect(itemAfter).not.toBeNull()
    expect(itemAfter.deletedAt).toBeNull()
    expect(Number(itemAfter.receivedQuantity)).toBe(40)

    // The Goods Receipt and its lineage back to the PO item remain
    // resolvable via a normal (default-scoped) query.
    const gr = await db.goodsReceipt.findByPk(grId)
    expect(gr).not.toBeNull()
    const grItem = await db.goodsReceiptItem.findOne({ where: { purchaseOrderItem: poItemId } })
    expect(grItem).not.toBeNull()
  })

  test('DELETE still works normally for an "ordered" PO that has not received anything yet', async () => {
    const poRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        status: 'ordered',
        items: [{ product: product.id, quantity: 20, price: 4000 }]
      })
    expect(poRes.status).toBe(201)
    const po = poRes.body.data

    const deleteRes = await request(app)
      .delete(`/purchase-order/delete/${po.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(deleteRes.status).toBe(200)

    const poAfter = await db.purchase_order.findByPk(po.id)
    expect(poAfter).toBeNull()
  })

  test('DELETE still works normally for a draft PO', async () => {
    const poRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        status: 'draft',
        items: [{ product: product.id, quantity: 10, price: 3000 }]
      })
    expect(poRes.status).toBe(201)
    const po = poRes.body.data

    const deleteRes = await request(app)
      .delete(`/purchase-order/delete/${po.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(deleteRes.status).toBe(200)

    const poAfter = await db.purchase_order.findByPk(po.id)
    expect(poAfter).toBeNull()
  })
})
