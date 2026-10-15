process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const { Op } = require('sequelize')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 31 Batch 1 — paid-order cancel/void requires a meaningful reason,
// recorded in the existing VOID audit trail. Kasir permission unchanged.
//
// NOTE: each paid order uses a FRESH product because POS creation writes a
// store-level stock row on first sale (pre-existing behavior); reusing one
// product across tests would couple them through store stock.
let location = null
let category = null
let kasirToken = null
let adminToken = null

const KASIR_ID = 7201
const ADMIN_ID = 7202
const createdProductIds = []

beforeAll(async () => {
  location = await db.location.create({ name: 'VOID_REASON_STORE', status: 'active' })
  category = await db.category.create({ name: 'VOID_REASON_CATEGORY' })
  // P1-4: central gate denies unknown caller identities; these rows give the
  // constant caller ids real identities. Assertions below are unchanged.
  await db.user.create({
    id: KASIR_ID,
    userName: 'kasir_void_reason',
    email: 'p14-7201-void-reason@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: location.id,
    status: 'active',
    fullName: 'kasir_void_reason'
  })
  await db.user.create({
    id: ADMIN_ID,
    userName: 'admin_void_reason',
    email: 'p14-7202-void-reason@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_void_reason'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  kasirToken = await signSessionToken(
    { id: KASIR_ID, userName: 'kasir_void_reason', roleType: 'kasir', store: location.id },
    JWT_SECRET
  )
  adminToken = await signSessionToken(
    { id: ADMIN_ID, userName: 'admin_void_reason', roleType: 'admin', store: location.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these void-reason assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'VOID_REASON_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })
  // DR-04: settling via update-status requires drawer attribution — seed
  // the open register the paid transition resolves at payment time.
  await db.cashRegister.destroy({ where: { store: location.id, status: 'open' }, force: true })
  await db.cashRegister.create({
    store: location.id,
    user: ADMIN_ID,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: location.id }, force: true })
  await db.auditLog.destroy({ where: { store: location.id }, force: true, __auditMaintenance: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.cashRegister.destroy({ where: { store: location.id }, force: true })
  // Users last: open-register rows reference the opener (FK).
  await db.user.destroy({ where: { id: [KASIR_ID, ADMIN_ID] }, force: true })
  for (const pid of createdProductIds) {
    await db.best_selling.destroy({ where: { productId: pid }, force: true })
    await db.stock_history.destroy({ where: { product: pid }, force: true })
    await db.product_store_stock.destroy({ where: { product: pid }, force: true })
    await db.product.destroy({ where: { id: pid }, force: true })
  }
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

async function makeProduct(stock = 50) {
  const p = await db.product.create({
    nameProduct: `VOIDRSN_PROD_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    category: category.id,
    price: 10000,
    stock
  })
  createdProductIds.push(p.id)
  return p
}

async function createPaidOrder(token, qty = 2) {
  const prod = await makeProduct(50)
  const res = await request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: location.id,
      items: [{ product: prod.id, quantity: qty }],
      paymentMethod: 'cash',
      cashierName: 'Void Reason Cashier'
    })
  expect(res.status).toBe(201)
  return { order: res.body.data, prod }
}

async function cancelOrder(token, id, body = {}) {
  return request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${token}`)
    .send({ id, status: 'cancelled', store: location.id, ...body })
}

async function refundTxns(orderId) {
  return db.transaction.findAll({
    where: { order: orderId, amount: { [Op.lt]: 0 } }
  })
}

async function voidAudits(orderId) {
  return db.auditLog.findAll({
    where: { entity: 'order', entityId: orderId, action: 'void' },
    order: [['id', 'ASC']]
  })
}

async function voidOrder(token, id, body = {}) {
  return request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${token}`)
    .send({ id, status: 'void', store: location.id, ...body })
}

// DR-23 (BA §35.10 G, DR-08): reversing a PAID order is a VOID — an elevated
// capability (interim: admin/super_admin) with a mandatory reason, an exact
// refund and stock reversal. Cancel is only for orders with nothing
// collected, so a paid cancel is refused with CANCEL_REQUIRES_VOID. The
// Phase 31 "kasir may cancel a paid order with a reason" path is superseded.
describe('paid-order reversal (void) requires a reason and an elevated capability', () => {
  test('1. paid void WITHOUT reason is rejected', async () => {
    const { order } = await createPaidOrder(kasirToken)
    const res = await voidOrder(adminToken, order.id)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('REASON_REQUIRED')
    const still = await db.order.findByPk(order.id)
    expect(still.status).toBe('paid')
    expect(await refundTxns(order.id)).toHaveLength(0)
  })

  test('2. paid void with empty reason is rejected', async () => {
    const { order } = await createPaidOrder(kasirToken)
    const res = await voidOrder(adminToken, order.id, { reason: '' })
    expect(res.status).toBe(422)
    const still = await db.order.findByPk(order.id)
    expect(still.status).toBe('paid')
  })

  test('3. paid void with whitespace-only reason is rejected', async () => {
    const { order } = await createPaidOrder(kasirToken)
    const res = await voidOrder(adminToken, order.id, { reason: '   ' })
    expect(res.status).toBe(422)
    const still = await db.order.findByPk(order.id)
    expect(still.status).toBe('paid')
  })

  test('4+5. kasir can no longer reverse a paid order: cancel → 409 CANCEL_REQUIRES_VOID, void → 403', async () => {
    const { order } = await createPaidOrder(kasirToken)
    const cancel = await cancelOrder(kasirToken, order.id, { reason: 'Customer changed mind' })
    expect(cancel.status).toBe(409)
    expect(cancel.body.code).toBe('CANCEL_REQUIRES_VOID')
    const voided = await voidOrder(kasirToken, order.id, { reason: 'Customer changed mind' })
    expect(voided.status).toBe(403)
    const still = await db.order.findByPk(order.id)
    expect(still.status).toBe('paid')
    expect(still.paymentStatus).toBe('paid')
    expect(await refundTxns(order.id)).toHaveLength(0)
  })

  test('6. admin void with valid reason succeeds', async () => {
    const { order } = await createPaidOrder(adminToken)
    const res = await voidOrder(adminToken, order.id, {
      reason: 'Duplicate order entered twice'
    })
    expect(res.status).toBe(200)
    const voided = await db.order.findByPk(order.id)
    expect(voided.status).toBe('void')
    expect(voided.paymentStatus).toBe('refunded')
  })

  test('7. void refunds exactly what was collected, in the original tender', async () => {
    const { order } = await createPaidOrder(kasirToken, 3)
    const full = await db.order.findByPk(order.id)
    const res = await voidOrder(adminToken, order.id, { reason: 'Out of stock item' })
    expect(res.status).toBe(200)
    const refunds = await refundTxns(order.id)
    expect(refunds).toHaveLength(1)
    expect(Number(refunds[0].amount)).toBe(-Math.abs(Number(full.totalPrice)))
    expect(refunds[0].typePayment).toBe('CASH')
    expect(Number(refunds[0].createdBy)).toBe(ADMIN_ID)
  })

  test('8. stock reversal still occurs exactly as before', async () => {
    const { order, prod } = await createPaidOrder(kasirToken, 4)
    const before = 50
    const mid = Number((await db.product.findByPk(prod.id)).stock)
    expect(mid).toBe(before - 4)
    const res = await voidOrder(adminToken, order.id, { reason: 'Kitchen closed early' })
    expect(res.status).toBe(200)
    const after = Number((await db.product.findByPk(prod.id)).stock)
    expect(after).toBe(before)
  })

  test('9+10. audit record contains reason and identifies actor/order/store/action', async () => {
    const { order } = await createPaidOrder(kasirToken)
    const reason = 'Customer paid wrong amount, re-ring'
    const res = await voidOrder(adminToken, order.id, { reason })
    expect(res.status).toBe(200)
    const audits = await voidAudits(order.id)
    expect(audits.length).toBeGreaterThanOrEqual(1)
    const audit = audits[audits.length - 1]
    expect(audit.action).toBe('void')
    expect(Number(audit.entityId)).toBe(Number(order.id))
    expect(Number(audit.store)).toBe(Number(location.id))
    expect(Number(audit.userId)).toBe(ADMIN_ID)
    expect(audit.description).toContain(reason)
    expect(audit.newValues && audit.newValues.reason).toBe(reason)
  })

  test('11+12. repeat void creates no duplicate refund or audit', async () => {
    const { order } = await createPaidOrder(kasirToken)
    const first = await voidOrder(adminToken, order.id, { reason: 'No show' })
    expect(first.status).toBe(200)
    expect(await refundTxns(order.id)).toHaveLength(1)
    expect(await voidAudits(order.id)).toHaveLength(1)
    // Repeat without reason: still a no-op success, no new side effects.
    const second = await voidOrder(adminToken, order.id)
    expect(second.status).toBe(200)
    expect(await refundTxns(order.id)).toHaveLength(1)
    expect(await voidAudits(order.id)).toHaveLength(1)
  })

  test('non-string reason is rejected by validation', async () => {
    const { order } = await createPaidOrder(kasirToken)
    const res = await cancelOrder(kasirToken, order.id, { reason: 12345 })
    expect([400, 422]).toContain(res.status)
    const still = await db.order.findByPk(order.id)
    expect(still.status).toBe('paid')
  })

  test('excessively long reason is rejected', async () => {
    const { order } = await createPaidOrder(kasirToken)
    const res = await cancelOrder(kasirToken, order.id, { reason: 'x'.repeat(501) })
    expect([400, 422]).toContain(res.status)
    const still = await db.order.findByPk(order.id)
    expect(still.status).toBe('paid')
  })

  test('13. unrelated paid settlement behavior unchanged (no reason needed)', async () => {
    const prod = await makeProduct(50)
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({
        store: location.id,
        items: [{ product: prod.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'Void Reason Cashier'
      })
    expect(res.status).toBe(201)
    const created = await db.order.findByPk(res.body.data.id)
    expect(created.paymentStatus).toBe('paid')
  })

  test('14. pending-to-paid settlement keeps cashReceived=null and changeGiven=0', async () => {
    const pending = await db.order.create({
      orderNumber: `VOIDRSN-PEND-${Date.now()}`,
      store: location.id,
      status: 'pending',
      paymentStatus: 'unpaid',
      subTotal: 10000,
      totalPrice: 11100,
      totalQuantity: 1,
      paymentMethod: 'qris',
      source: 'qr',
      createdBy: KASIR_ID
    })
    const res = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${kasirToken}`)
      // DR-23 §D: the order's QRIS tender requires a settlement reference.
      .send({ id: pending.id, status: 'paid', store: location.id, referenceNumber: 'VOIDRSN-QR-1' })
    expect(res.status).toBe(200)
    const txn = await db.transaction.findOne({ where: { order: pending.id } })
    expect(txn).not.toBeNull()
    expect(txn.cashReceived).toBeNull()
    expect(Number(txn.changeGiven)).toBe(0)
  })
})
