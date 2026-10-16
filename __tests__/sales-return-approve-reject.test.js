process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let category = null
let product = null
let adminToken = null
let returnCounter = 0

const makeOrder = async (qty) => {
  const createRes = await request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(withIdempotencyKey({
      store: location.id,
      items: [{ product: product.id, quantity: qty }],
      paymentMethod: 'cash',
      cashierName: 'Test Cashier'
    }))
  return createRes.body.data
}

const makeReturn = async ({ order, qty, refundAmount }) => {
  returnCounter += 1
  const ret = await db.sales_return.create({
    order: order.id,
    store: location.id,
    returnNumber: `SR-TEST-${Date.now()}-${returnCounter}`,
    status: 'pending',
    reason: 'Test return',
    refundAmount,
    refundMethod: 'cash'
  })
  await db.sales_return_item.create({
    salesReturn: ret.id,
    product: product.id,
    qty,
    unit: 'pcs'
  })
  return ret
}

let adminUser = null

beforeAll(async () => {
  location = await db.location.create({ name: 'SR_FLOW_STORE', status: 'active' })
  category = await db.category.create({ name: 'SR_FLOW_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'SR_FLOW_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100
  })
  await db.product_store_stock.create({
    product: product.id,
    store: location.id,
    stock: product.stock
  })
  // A real user row is required now that approve() populates the
  // FK-constrained approvedBy column (F4) — a synthetic, unbacked JWT id
  // previously worked only because nothing in this flow wrote it to an
  // FK column before.
  adminUser = await db.user.create({
    userName: 'admin_sr_flow',
    email: 'admin_sr_flow@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: location.id },
    JWT_SECRET
  )
  // DR-23: a void's cash refund is attributed to the open register; sales
  // made while it is open belong to it.
  await db.cashRegister.create({
    store: location.id,
    user: adminUser.id,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these approve/reject assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'SR_FLOW_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: location?.id }, force: true })
  await db.sales_return_item.destroy({ where: {}, force: true })
  // P1 linkage hardening: transaction.salesReturnId is RESTRICT — refund
  // ledger rows must go before the returns they reference (cleanup order
  // only; no assertion changed).
  await db.transaction.destroy({ where: {}, force: true })
  await db.sales_return.destroy({ where: { store: location.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.best_selling.destroy({ where: { productId: product?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.user.destroy({ where: { id: adminUser?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('PATCH /sales-return/approve and /reject', () => {
  test('approve restores stock, records a refund transaction, and recomputes order paymentStatus', async () => {
    const order = await makeOrder(10)
    const beforeStock = await db.product.findByPk(product.id)

    const ret = await makeReturn({ order, qty: 4, refundAmount: 40000 })

    const res = await request(app)
      .patch(`/sales-return/approve/${ret.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: ret.id })

    expect(res.status).toBe(200)

    const afterStock = await db.product.findByPk(product.id)
    expect(Number(afterStock.stock)).toBe(Number(beforeStock.stock) + 4)

    const refundTxn = await db.transaction.findOne({
      where: { order: order.id, salesReturnId: ret.id }
    })
    expect(refundTxn).not.toBeNull()
    expect(Number(refundTxn.amount)).toBe(-40000)

    const updatedRet = await db.sales_return.findByPk(ret.id)
    expect(updatedRet.status).toBe('approved')
  })

  test('two simultaneous approve calls on the same return: exactly one succeeds, stock restored exactly once', async () => {
    const order = await makeOrder(10)
    const beforeStock = await db.product.findByPk(product.id)
    const ret = await makeReturn({ order, qty: 3, refundAmount: 30000 })

    const [r1, r2] = await Promise.all([
      request(app)
        .patch(`/sales-return/approve/${ret.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: ret.id }),
      request(app)
        .patch(`/sales-return/approve/${ret.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: ret.id })
    ])

    const statuses = [r1.status, r2.status].sort()
    // One wins (200), the other must see the now-'approved' status and be
    // rejected with 409 (business conflict — F4's standardized status
    // code, was 400) — not both silently succeed.
    expect(statuses).toEqual([200, 409])

    const afterStock = await db.product.findByPk(product.id)
    expect(Number(afterStock.stock)).toBe(Number(beforeStock.stock) + 3)

    const refundTxns = await db.transaction.findAll({
      where: { salesReturnId: ret.id }
    })
    expect(refundTxns.length).toBe(1)
  })

  test('approve racing reject on the same return never leaves it rejected with the refund already applied', async () => {
    const order = await makeOrder(10)
    const ret = await makeReturn({ order, qty: 2, refundAmount: 20000 })

    const [approveRes, rejectRes] = await Promise.all([
      request(app)
        .patch(`/sales-return/approve/${ret.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: ret.id }),
      request(app)
        .patch(`/sales-return/reject/${ret.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: ret.id })
    ])

    const finalRet = await db.sales_return.findByPk(ret.id)
    const refundTxns = await db.transaction.findAll({
      where: { salesReturnId: ret.id }
    })

    if (finalRet.status === 'approved') {
      // Approve won the race: exactly one refund txn must exist.
      expect(approveRes.status).toBe(200)
      expect(rejectRes.status).toBe(409)
      expect(refundTxns.length).toBe(1)
    } else {
      // Reject won the race: approve must have been blocked, and no
      // refund/stock-restore side effect may exist for a rejected return.
      expect(finalRet.status).toBe('rejected')
      expect(rejectRes.status).toBe(200)
      expect(approveRes.status).toBe(409)
      expect(refundTxns.length).toBe(0)
    }
  })

  test('reject on an already-approved return is refused, not silently accepted', async () => {
    const order = await makeOrder(10)
    const ret = await makeReturn({ order, qty: 1, refundAmount: 10000 })

    const approveRes = await request(app)
      .patch(`/sales-return/approve/${ret.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: ret.id })
    expect(approveRes.status).toBe(200)

    const rejectRes = await request(app)
      .patch(`/sales-return/reject/${ret.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: ret.id })
    expect(rejectRes.status).toBe(409)

    const finalRet = await db.sales_return.findByPk(ret.id)
    expect(finalRet.status).toBe('approved')
  })

  test('approving a return with multiple items restores stock for every item, batched in one product fetch', async () => {
    // Regression test for the validation+mutation loop merge: with 2+
    // items, every item's product must still be resolved and mutated
    // correctly from the single batched fetch, not just the first one.
    const otherProduct = await db.product.create({
      nameProduct: 'SR_BATCH_OTHER_PRODUCT',
      category: category.id,
      price: 5000,
      stock: 50
    })

    const orderRes = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [
          { product: product.id, quantity: 5 },
          { product: otherProduct.id, quantity: 3 }
        ],
        paymentMethod: 'cash',
        cashierName: 'Test Cashier'
      }))
    expect(orderRes.status).toBe(201)
    const order = orderRes.body.data

    const beforeA = await db.product.findByPk(product.id)
    const beforeB = await db.product.findByPk(otherProduct.id)

    returnCounter += 1
    const ret = await db.sales_return.create({
      order: order.id,
      store: location.id,
      returnNumber: `SR-TEST-BATCH-${Date.now()}-${returnCounter}`,
      status: 'pending',
      reason: 'Test multi-item return',
      refundAmount: 8000,
      refundMethod: 'cash'
    })
    await db.sales_return_item.bulkCreate([
      { salesReturn: ret.id, product: product.id, qty: 2, unit: 'pcs' },
      { salesReturn: ret.id, product: otherProduct.id, qty: 1, unit: 'pcs' }
    ])

    const res = await request(app)
      .patch(`/sales-return/approve/${ret.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: ret.id })
    expect(res.status).toBe(200)

    const afterA = await db.product.findByPk(product.id)
    const afterB = await db.product.findByPk(otherProduct.id)
    expect(Number(afterA.stock)).toBe(Number(beforeA.stock) + 2)
    expect(Number(afterB.stock)).toBe(Number(beforeB.stock) + 1)

    // otherProduct now has sales_return_item history referencing it — the
    // FK is RESTRICT (F4), so that history must go first, matching the
    // new financial-history-integrity guarantee under test elsewhere.
    // P1 linkage hardening: the approved return also has a refund ledger
    // row (salesReturnId, RESTRICT) — it goes first as well.
    await db.transaction.destroy({ where: { salesReturnId: ret.id }, force: true })
    await db.sales_return_item.destroy({ where: { salesReturn: ret.id }, force: true })
    await db.sales_return.destroy({ where: { id: ret.id }, force: true })
    await db.product.destroy({ where: { id: otherProduct.id }, force: true })
  })

  test('voiding the order racing approval of its pending return: stock is restored exactly once, never twice', async () => {
    // Cross-endpoint double-restore race. DR-23 (BA §35.10 G): reversing a
    // PAID order is an elevated void (a plain cancel is refused while money
    // is collected), so the reversal racing the return approval is a void.
    // Both lock the same order row, so exactly one wins and the other
    // observes the consequence and refuses.
    const order = await makeOrder(10)
    const beforeStock = await db.product.findByPk(product.id)
    const ret = await makeReturn({ order, qty: 3, refundAmount: 30000 })

    const [voidRes, approveRes] = await Promise.all([
      request(app)
        .put('/order/update-status')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: order.id, status: 'void', store: location.id, reason: 'Race test void reason' }),
      request(app)
        .patch(`/sales-return/approve/${ret.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: ret.id })
    ])

    const finalOrder = await db.order.findByPk(order.id)
    const finalReturn = await db.sales_return.findByPk(ret.id)
    const afterStock = await db.product.findByPk(product.id)
    const refundTxns = await db.transaction.findAll({ where: { salesReturnId: ret.id } })

    if (finalOrder.status === 'void') {
      // Void won: the full order quantity (10) is restored and the full
      // collected amount refunded; approve() must have seen the voided
      // order and refused — the return's own 3-unit restore must NOT also
      // have applied on top.
      expect(voidRes.status).toBe(200)
      expect(approveRes.status).toBe(409)
      expect(finalReturn.status).toBe('pending')
      expect(Number(afterStock.stock)).toBe(Number(beforeStock.stock) + 10)
      expect(refundTxns.length).toBe(0)
    } else {
      // Approve won: only the return's 3 units are restored; the order is
      // now PARTIALLY_REFUNDED, which cannot be voided in v1 — the order
      // stays paid and the other 7 units (never returned) are not restored.
      expect(approveRes.status).toBe(200)
      expect(voidRes.status).toBe(409)
      expect(voidRes.body.code).toBe('VOID_NOT_APPLICABLE')
      expect(finalReturn.status).toBe('approved')
      expect(finalOrder.status).toBe('paid')
      expect(Number(afterStock.stock)).toBe(Number(beforeStock.stock) + 3)
      expect(refundTxns.length).toBe(1)
    }
    const ledger = await db.transaction.findAll({ where: { order: order.id } })
    const collected = ledger.filter((t) => Number(t.amount) > 0).reduce((sum, t) => sum + Number(t.amount), 0)
    const refunded = ledger.filter((t) => Number(t.amount) < 0).reduce((sum, t) => sum - Number(t.amount), 0)
    expect(refunded).toBeLessThanOrEqual(collected)
  })
})
