process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 12 (F22-B10-03 investigation): Purchase Return has no
// structured lineage to a specific goodsReceipt/goodsReceiptItem — only to
// purchase_order, with return items matched to purchase_order_item by a
// product/ingredient/ingredientName identity KEY. Purchase Order creation
// explicitly allows two separate line items for the SAME product from
// DIFFERENT suppliers (its own duplicate-item guard keys on
// product+supplier, not product alone — api/controller/purchaseOrder.js).
//
// purchaseReturn.js's create() builds its validation map the same way:
// `poItemMap[key] = {...}` — a plain object-key ASSIGNMENT, not an
// aggregation. When two PO items collide on the same key (this exact
// multi-supplier scenario), the second one silently overwrites the first
// in the map, so the "how much is available to return" check only sees
// ONE line item's receivedQuantity instead of the true combined total —
// a real, reachable correctness defect, not merely a theoretical gap.
//
// The full GR-document-level lineage Batch 10 originally described would
// need a schema change (out of scope here). This test proves and fixes
// the narrower, code-only-fixable defect the investigation surfaced: the
// available-quantity check must aggregate receivedQuantity across every
// PO item sharing an identity key, not silently pick whichever happens to
// be last.

let location = null
let category = null
let product = null
let supplier1 = null
let supplier2 = null
let adminToken = null

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'PR_MULTISUP_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PR_MULTISUP_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PR_MULTISUP_PRODUCT',
    category: category.id,
    price: 9000,
    costPrice: 5000,
    stock: 0
  })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 0 })
  supplier1 = await db.supplier.create({ name: 'PR_MULTISUP_SUPPLIER_1' })
  supplier2 = await db.supplier.create({ name: 'PR_MULTISUP_SUPPLIER_2' })

  const adminUser = await db.user.create({
    userName: 'admin_pr_multisup',
    email: 'admin_pr_multisup@test.com',
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
  await db.purchase_return_item.destroy({ where: {}, force: true })
  await db.purchase_return.destroy({ where: { store: location.id }, force: true })
  await db.stock_history.destroy({ where: {}, force: true })
  await db.product_batch_stock.destroy({ where: {}, force: true })
  await db.product_batch.destroy({ where: {}, force: true })
  await db.goodsReceiptItem.destroy({ where: {}, force: true })
  await db.goodsReceipt.destroy({ where: { store: location.id }, force: true })
  await db.accounting_outbox.destroy({ where: { store: location.id }, force: true })
  await db.journal_entry_line.destroy({ where: {}, force: true })
  await db.journal_entry.destroy({ where: { store: location.id }, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: { store: location.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.supplier.destroy({ where: { id: [supplier1.id, supplier2.id] }, force: true })
  await db.user.destroy({ where: { userName: 'admin_pr_multisup' }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('F22-B10-03 — Purchase Return availability check across multiple PO lines for the same product', () => {
  test('a PO with two lines for the same product from different suppliers: return availability is the true combined total, not whichever line wins an object-key collision', async () => {
    const poRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        status: 'ordered',
        items: [
          { product: product.id, supplier: supplier1.id, quantity: 50, price: 5000 },
          { product: product.id, supplier: supplier2.id, quantity: 30, price: 5500 }
        ]
      })
    expect(poRes.status).toBe(201)
    const po = poRes.body.data
    expect(po.items.length).toBe(2)

    for (const poItem of po.items) {
      const grRes = await request(app)
        .post('/goods-receipt/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          store: location.id,
          purchaseOrderId: po.id,
          status: 'completed',
          items: [
            {
              purchaseOrderItem: poItem.id,
              product: product.id,
              qtyReceived: poItem.quantity,
              price: poItem.price
            }
          ]
        })
      expect(grRes.status).toBe(201)
    }

    const freshProduct = await db.product.findByPk(product.id)
    expect(Number(freshProduct.stock)).toBe(80) // sanity: both lines' stock landed

    // True combined received quantity is 50 + 30 = 80. A return of 45 is
    // legitimate against that true total, but exceeds either individual
    // line (30 or 50) alone — proving the check isn't silently keyed to
    // just one of the two colliding PO items.
    const returnRes = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: po.id,
        reason: 'Multi-supplier availability check',
        items: [{ productId: product.id, qty: 45 }]
      })
    expect(returnRes.status).toBe(201)
  })

  test('the same PO configuration still correctly rejects a return that exceeds the TRUE combined total (80)', async () => {
    const poRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        status: 'ordered',
        items: [
          { product: product.id, supplier: supplier1.id, quantity: 50, price: 5000 },
          { product: product.id, supplier: supplier2.id, quantity: 30, price: 5500 }
        ]
      })
    const po = poRes.body.data

    for (const poItem of po.items) {
      await request(app)
        .post('/goods-receipt/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          store: location.id,
          purchaseOrderId: po.id,
          status: 'completed',
          items: [
            {
              purchaseOrderItem: poItem.id,
              product: product.id,
              qtyReceived: poItem.quantity,
              price: poItem.price
            }
          ]
        })
    }

    const returnRes = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: po.id,
        reason: 'Over the true combined total',
        items: [{ productId: product.id, qty: 81 }]
      })
    expect(returnRes.status).toBe(400)
  })
})
