process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 15 (F22-B10-06): purchaseReturn.js create()'s returnable-
// quantity validation reads `purchase_order_item` (and existing returns)
// via a plain, unlocked findAll — and, worse than the Goods Receipt case
// (F22-B10-05), this read happens entirely OUTSIDE any transaction at all;
// `db.sequelize.transaction()` only opens later, after validation has
// already decided to proceed. `available = receivedQty - alreadyReturned`
// is computed from that unlocked snapshot. Two concurrent return requests
// for the same PO item can both read the same stale receivedQty/
// alreadyReturned, both individually pass the check, and jointly return
// more than was actually received — the same race class already fixed for
// concurrent Purchase Payments (purchase-payment-flow.test.js) and for
// Goods Receipt over-delivery (Batch 14).

let store = null
let category = null
let product = null
let adminToken = null

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'PR_CONCURRENCY_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PR_CONCURRENCY_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PR_CONCURRENCY_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 0 })
  const adminUser = await db.user.create({
    userName: 'admin_pr_concurrency',
    email: 'admin_pr_concurrency@test.com',
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
  await db.purchase_return_item.destroy({ where: {}, force: true })
  await db.purchase_return.destroy({ where: { store: store.id }, force: true })
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
  await db.user.destroy({ where: { userName: 'admin_pr_concurrency' }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F22-B10-06 — Purchase Return returnable-quantity validation race', () => {
  test('two concurrent returns that would jointly exceed the actually received quantity: exactly one is accepted', async () => {
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
        items: [{ purchaseOrderItem: poItemId, product: product.id, qtyReceived: 100, price: 5000 }]
      })
    expect(grRes.status).toBe(201)

    // Each individually fits under the 100-unit received quantity (70 < 100,
    // 50 < 100), but together they'd over-return by 20 — the exact race the
    // unlocked, pre-transaction read-then-validate sequence is vulnerable to.
    const fireReturn = (qty) =>
      request(app)
        .post('/purchase-return/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          purchaseOrder: po.id,
          reason: 'Concurrency race check',
          items: [{ productId: product.id, qty }]
        })

    const [resA, resB] = await Promise.all([fireReturn(70), fireReturn(50)])

    const statuses = [resA.status, resB.status].sort()
    expect(statuses).toEqual([201, 400])

    const totalReturned = await db.purchase_return_item.sum('qty', {
      where: { product: product.id }
    })
    expect(totalReturned).toBeLessThanOrEqual(100)
    // Exactly the successful request's quantity — never the sum of both.
    expect([70, 50]).toContain(totalReturned)

    const freshProduct = await db.product.findByPk(product.id)
    // stock: +100 (GR) - totalReturned (whichever one succeeded)
    expect(Number(freshProduct.stock)).toBe(100 - totalReturned)
  })
})
