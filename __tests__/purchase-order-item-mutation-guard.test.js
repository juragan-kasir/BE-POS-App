process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 16 (F22-B10-07): purchaseOrder.js update()'s item
// mutation path destroys ALL existing purchase_order_item rows and
// recreates them from the request body whenever `items` is present in
// the update payload (lines ~712-761). The only status guard on this
// endpoint blocks 'received'/'cancelled' — a PO at 'ordered' (already
// has real goods received against it, tracked via receivedQuantity) is
// still treated as freely item-mutable.
//
// This is reachable and materially violates the intended lifecycle:
// destroy+recreate assigns brand-new purchase_order_item ids, so any
// existing goodsReceiptItem.purchaseOrderItem FK pointing at the old
// (now soft-deleted) row becomes orphaned, and receivedQuantity carry-
// over only works if the new item's identity key (product/ingredient +
// supplier) happens to exactly match an old one — any edit that changes
// product/ingredient/supplier, or removes/reorders items, silently
// drops the already-received quantity's home, letting the same physical
// goods be received again against a fresh receivedQuantity:0 row.
//
// The fix must NOT make every field of a non-draft PO immutable — only
// the destructive items rewrite, and only once real receiving has
// actually happened (receivedQuantity > 0 on an existing item). Header-
// only updates (notes, dueDate, pic, tax fields, etc.) must keep working
// exactly as before, at any status short of received/cancelled.

let store = null
let category = null
let product = null
let adminToken = null

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'PO_ITEM_GUARD_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PO_ITEM_GUARD_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PO_ITEM_GUARD_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 0 })
  const adminUser = await db.user.create({
    userName: 'admin_po_item_guard',
    email: 'admin_po_item_guard@test.com',
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
  await db.user.destroy({ where: { userName: 'admin_po_item_guard' }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F22-B10-07 — Purchase Order item mutation is blocked once real receiving has happened', () => {
  test('update() with an items array is rejected once the PO item has a non-zero receivedQuantity, and the original item/history survives unchanged', async () => {
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
    const originalItemId = po.items[0].id

    const grRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [{ purchaseOrderItem: originalItemId, product: product.id, qtyReceived: 40, price: 5000 }]
      })
    expect(grRes.status).toBe(201)

    const beforeUpdate = await db.purchase_order_item.findByPk(originalItemId)
    expect(Number(beforeUpdate.receivedQuantity)).toBe(40)

    // Attempt to rewrite the item list — e.g. a client trying to correct
    // the ordered quantity after partial receiving has already occurred.
    const updateRes = await request(app)
      .put(`/purchase-order/update/${po.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ product: product.id, quantity: 200, price: 5500 }]
      })
    expect(updateRes.status).toBe(400)

    // The original item must survive untouched — same id, same quantity,
    // same receivedQuantity, not destroyed-and-recreated.
    const afterUpdate = await db.purchase_order_item.findByPk(originalItemId)
    expect(afterUpdate).not.toBeNull()
    expect(Number(afterUpdate.quantity)).toBe(100)
    expect(Number(afterUpdate.receivedQuantity)).toBe(40)

    // No new item was created in its place.
    const allItems = await db.purchase_order_item.findAll({ where: { purchaseOrder: po.id } })
    expect(allItems.length).toBe(1)
    expect(allItems[0].id).toBe(originalItemId)

    // The existing goodsReceiptItem's FK to the original PO item must
    // still resolve — proving no orphaning occurred.
    const grItem = await db.goodsReceiptItem.findOne({ where: { purchaseOrderItem: originalItemId } })
    expect(grItem).not.toBeNull()
  })

  test('update() with an items array still works normally when nothing has been received yet', async () => {
    const poRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        status: 'ordered',
        items: [{ product: product.id, quantity: 30, price: 4000 }]
      })
    expect(poRes.status).toBe(201)
    const po = poRes.body.data

    const updateRes = await request(app)
      .put(`/purchase-order/update/${po.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ product: product.id, quantity: 50, price: 4200 }]
      })
    expect(updateRes.status).toBe(200)

    const items = await db.purchase_order_item.findAll({ where: { purchaseOrder: po.id } })
    expect(items.length).toBe(1)
    expect(Number(items[0].quantity)).toBe(50)
  })

  test('header-only update() (no items in the payload) still works normally after receiving has started', async () => {
    const poRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        status: 'ordered',
        items: [{ product: product.id, quantity: 20, price: 3000 }]
      })
    expect(poRes.status).toBe(201)
    const po = poRes.body.data

    // Partial receipt only — a full receipt would flip the PO to
    // 'received' (Batch 11's return-aware fulfillment), which the
    // pre-existing, unrelated update() guard already blocks regardless
    // of this batch's fix. Keeping it partial isolates what THIS test is
    // actually verifying: header-only edits stay allowed at 'ordered'.
    const grRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [{ purchaseOrderItem: po.items[0].id, product: product.id, qtyReceived: 15, price: 3000 }]
      })
    expect(grRes.status).toBe(201)
    expect((await db.purchase_order.findByPk(po.id)).status).toBe('ordered')

    const updateRes = await request(app)
      .put(`/purchase-order/update/${po.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notes: 'updated notes only' })
    expect(updateRes.status).toBe(200)

    const fresh = await db.purchase_order.findByPk(po.id)
    expect(fresh.notes).toBe('updated notes only')
  })
})
