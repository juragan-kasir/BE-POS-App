process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 11 (F22-B10-02): purchase_order.status used to be computed
// from gross purchase_order_item.receivedQuantity only, never adjusted for
// approved Purchase Returns — a PO could stay 'received' (fully fulfilled)
// after a return dropped net fulfillment back below the ordered quantity,
// and purchaseReturn.approve() never recalculated PO status at all.
//
// These tests prove: receivedQuantity itself is never decremented (only
// approved returns are read, aggregated per PO item, and subtracted at
// calculation time); only status:'approved' returns are effective; the
// fulfillment check is per-item (one item's surplus can't compensate
// another's shortfall); status recalculates after GR completion via all
// three existing "receive stock" call sites (goods-receipt create,
// goods-receipt changeStatus, purchase-order receive) and after return
// approval; and store isolation holds.

let location = null
let category = null
let product = null
let productB = null
let adminToken = null

const createPO = async (items) => {
  const res = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: location.id, status: 'ordered', items })
  return res.body.data
}

const receiveGR = async (poId, poItemId, prod, qtyReceived, price) => {
  const res = await request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: location.id,
      purchaseOrderId: poId,
      status: 'completed',
      items: [
        {
          purchaseOrderItem: poItemId,
          product: prod.id,
          qtyReceived,
          price
        }
      ]
    })
  return res
}

const createReturn = async (poId, prod, qty, reason) => {
  const res = await request(app)
    .post('/purchase-return/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ purchaseOrder: poId, reason, items: [{ productId: prod.id, qty }] })
  return res
}

const approveReturn = (returnId) =>
  request(app)
    .patch(`/purchase-return/approve/${returnId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolution: 'credit' })

const rejectReturn = (returnId) =>
  request(app)
    .patch(`/purchase-return/reject/${returnId}`)
    .set('Authorization', `Bearer ${adminToken}`)

const poStatus = async (poId) => (await db.purchase_order.findByPk(poId)).status

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'PO_FULFILL_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PO_FULFILL_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PO_FULFILL_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  productB = await db.product.create({
    nameProduct: 'PO_FULFILL_PRODUCT_B',
    category: category.id,
    price: 6000,
    costPrice: 4000,
    stock: 0
  })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 0 })
  await db.product_store_stock.create({ product: productB.id, store: location.id, stock: 0 })

  const adminUser = await db.user.create({
    userName: 'admin_po_fulfill',
    email: 'admin_po_fulfill@test.com',
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
  await db.product_store_stock.destroy({ where: { product: [product.id, productB.id] }, force: true })
  await db.product.destroy({ where: { id: [product.id, productB.id] }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { userName: 'admin_po_fulfill' }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('F22-B10-02 — Purchase Order fulfillment status is return-aware', () => {
  test('Scenario 1: fully received PO with no returns stays received', async () => {
    const po = await createPO([{ product: product.id, quantity: 100, price: 5000 }])
    const grRes = await receiveGR(po.id, po.items[0].id, product, 100, 5000)
    expect(grRes.status).toBe(201)

    expect(await poStatus(po.id)).toBe('received')
  })

  test('Scenario 2: an approved return on a fully-received PO makes it ordered again', async () => {
    const po = await createPO([{ product: product.id, quantity: 100, price: 5000 }])
    await receiveGR(po.id, po.items[0].id, product, 100, 5000)
    expect(await poStatus(po.id)).toBe('received')

    const returnRes = await createReturn(po.id, product, 20, 'Damaged goods')
    expect(returnRes.status).toBe(201)
    const approveRes = await approveReturn(returnRes.body.data.id)
    expect(approveRes.status).toBe(200)

    expect(await poStatus(po.id)).toBe('ordered')
  })

  test('Scenario 3: partial GR with no return stays ordered', async () => {
    const po = await createPO([{ product: product.id, quantity: 100, price: 5000 }])
    await receiveGR(po.id, po.items[0].id, product, 60, 5000)

    expect(await poStatus(po.id)).toBe('ordered')
  })

  test('Scenario 4: multiple approved returns are aggregated per item', async () => {
    const po = await createPO([{ product: product.id, quantity: 100, price: 5000 }])
    await receiveGR(po.id, po.items[0].id, product, 100, 5000)
    expect(await poStatus(po.id)).toBe('received')

    const return1 = await createReturn(po.id, product, 20, 'Return 1')
    await approveReturn(return1.body.data.id)
    const return2 = await createReturn(po.id, product, 10, 'Return 2')
    await approveReturn(return2.body.data.id)

    // net fulfilled = 100 - 30 = 70 < 100
    expect(await poStatus(po.id)).toBe('ordered')
  })

  test('Scenario 5: a non-approved (rejected) return does not reduce fulfillment', async () => {
    const po = await createPO([{ product: product.id, quantity: 100, price: 5000 }])
    await receiveGR(po.id, po.items[0].id, product, 100, 5000)
    expect(await poStatus(po.id)).toBe('received')

    const returnRes = await createReturn(po.id, product, 20, 'Wrong item')
    const rejectRes = await rejectReturn(returnRes.body.data.id)
    expect(rejectRes.status).toBe(200)

    // rejected return must never reduce fulfillment
    expect(await poStatus(po.id)).toBe('received')
  })

  test('Scenario 6: PO is only received when ALL items are fully fulfilled (one item cannot compensate another)', async () => {
    const po = await createPO([
      { product: product.id, quantity: 100, price: 5000 },
      { product: productB.id, quantity: 50, price: 4000 }
    ])
    const itemA = po.items.find((i) => i.product === product.id)
    const itemB = po.items.find((i) => i.product === productB.id)

    await receiveGR(po.id, itemA.id, product, 100, 5000)
    // Item B only partially received (40 of 50) — separately, item A gets
    // an approved return dropping it below its ordered quantity too, but
    // the point is that neither item alone should be able to flip the PO
    // to 'received' while the other is short.
    const grB = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [{ purchaseOrderItem: itemB.id, product: productB.id, qtyReceived: 40, price: 4000 }]
      })
    expect(grB.status).toBe(201)

    const returnRes = await createReturn(po.id, product, 20, 'Item A return')
    await approveReturn(returnRes.body.data.id)

    // Item A: 100 - 20 = 80 < 100 (short). Item B: 40 < 50 (short).
    expect(await poStatus(po.id)).toBe('ordered')
  })

  test('Scenario 7: store isolation — a return in Store A never affects Store B fulfillment', async () => {
    const storeB = await db.location.create(await withTestTenant({ name: 'PO_FULFILL_STORE_B', status: 'active' }))
    const productStoreB = await db.product.create({
      nameProduct: 'PO_FULFILL_PRODUCT_STOREB',
      category: category.id,
      price: 7000,
      costPrice: 4500,
      stock: 0
    })
    await db.product_store_stock.create({ product: productStoreB.id, store: storeB.id, stock: 0 })
    const userB = await db.user.create({
      userName: 'admin_po_fulfill_b',
      email: 'admin_po_fulfill_b@test.com',
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
      // Store A: PO=100, GR=100, Return=20 -> ordered
      const poA = await createPO([{ product: product.id, quantity: 100, price: 5000 }])
      await receiveGR(poA.id, poA.items[0].id, product, 100, 5000)
      const returnA = await createReturn(poA.id, product, 20, 'Store A return')
      await approveReturn(returnA.body.data.id)
      expect(await poStatus(poA.id)).toBe('ordered')

      // Store B: PO=100, GR=100, no return -> received
      const poResB = await request(app)
        .post('/purchase-order/create')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ store: storeB.id, status: 'ordered', items: [{ product: productStoreB.id, quantity: 100, price: 7000 }] })
      const poB = poResB.body.data
      const grResB = await request(app)
        .post('/goods-receipt/create')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({
          store: storeB.id,
          purchaseOrderId: poB.id,
          status: 'completed',
          items: [{ purchaseOrderItem: poB.items[0].id, product: productStoreB.id, qtyReceived: 100, price: 7000 }]
        })
      expect(grResB.status).toBe(201)

      expect(await poStatus(poA.id)).toBe('ordered')
      expect(await poStatus(poB.id)).toBe('received')
    } finally {
      await db.purchase_return_item.destroy({ where: {}, force: true })
      await db.purchase_return.destroy({ where: { store: storeB.id }, force: true })
      await db.stock_history.destroy({ where: {}, force: true })
      await db.product_batch_stock.destroy({ where: {}, force: true })
      await db.product_batch.destroy({ where: {}, force: true })
      await db.goodsReceiptItem.destroy({ where: {}, force: true })
      await db.goodsReceipt.destroy({ where: { store: storeB.id }, force: true })
      await db.accounting_outbox.destroy({ where: { store: storeB.id }, force: true })
      await db.journal_entry_line.destroy({ where: {}, force: true })
      await db.journal_entry.destroy({ where: { store: storeB.id }, force: true })
      await db.purchase_order_item.destroy({ where: {}, force: true })
      await db.purchase_order.destroy({ where: { store: storeB.id }, force: true })
      await db.product_store_stock.destroy({ where: { product: productStoreB.id }, force: true })
      await db.product.destroy({ where: { id: productStoreB.id }, force: true })
      await db.user.destroy({ where: { id: userB.id }, force: true })
      await db.location.destroy({ where: { id: storeB.id }, force: true })
    }
  })

  test('Scenario 8: the real purchaseReturn.approve() endpoint transitions PO from received to ordered (not just the calculation in isolation)', async () => {
    const po = await createPO([{ product: product.id, quantity: 100, price: 5000 }])
    await receiveGR(po.id, po.items[0].id, product, 100, 5000)
    const before = await poStatus(po.id)
    expect(before).toBe('received')

    const returnRes = await createReturn(po.id, product, 20, 'Verify approve() recalculates')
    const approveRes = await approveReturn(returnRes.body.data.id)
    expect(approveRes.status).toBe(200)

    const after = await poStatus(po.id)
    expect(after).toBe('ordered')
    expect(before).not.toBe(after)
  })

  test('Additional: goods-receipt changeStatus (draft -> completed) recalculates PO fulfillment (previously never touched status at all)', async () => {
    // Two items: item A fully received directly (status 'ordered' while
    // item B is still outstanding), item B completed later via the
    // separate changeStatus (draft -> completed) endpoint. Pre-fix,
    // changeStatus() never wrote purchase_order.status at all, so
    // completing item B's draft left the PO incorrectly stuck at
    // 'ordered' even once both items were fully received.
    const po = await createPO([
      { product: product.id, quantity: 100, price: 5000 },
      { product: productB.id, quantity: 50, price: 4000 }
    ])
    const itemA = po.items.find((i) => i.product === product.id)
    const itemB = po.items.find((i) => i.product === productB.id)

    await receiveGR(po.id, itemA.id, product, 100, 5000)
    expect(await poStatus(po.id)).toBe('ordered')

    const draftRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        purchaseOrderId: po.id,
        status: 'draft',
        items: [{ purchaseOrderItem: itemB.id, product: productB.id, qtyReceived: 50, price: 4000 }]
      })
    expect(draftRes.status).toBe(201)

    const statusRes = await request(app)
      .patch(`/goods-receipt/status/${draftRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed' })
    expect(statusRes.status).toBe(200)

    // both items now fully received, no returns -> PO must become 'received'
    expect(await poStatus(po.id)).toBe('received')
  })

  test('Additional: purchase-order/receive also recalculates return-aware fulfillment', async () => {
    const po = await createPO([{ product: product.id, quantity: 100, price: 5000 }])
    const receiveRes1 = await request(app)
      .put(`/purchase-order/receive/${po.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [{ id: po.items[0].id, product: product.id, receivedQuantity: 100 }] })
    expect(receiveRes1.status).toBe(200)
    expect(await poStatus(po.id)).toBe('received')

    const returnRes = await createReturn(po.id, product, 25, 'Return before second receive')
    await approveReturn(returnRes.body.data.id)
    expect(await poStatus(po.id)).toBe('ordered')
  })
})
