process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let category = null
let product = null
let cashierToken = null
let adminToken = null

beforeAll(async () => {
  location = await db.location.create({ name: 'ORD_CANCEL_STORE', status: 'active' })
  category = await db.category.create({ name: 'ORD_CANCEL_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'ORD_CANCEL_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 20
  })
  // DR-14: the outlet row is the authoritative stock.
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 20 })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7101,
    userName: 'cashier_ord_cancel',
    email: 'p14-7101-order-cancel-flow@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: location.id,
    status: 'active',
    fullName: 'cashier_ord_cancel'
  })
  await db.user.create({
    id: 7102,
    userName: 'admin_ord_cancel',
    email: 'p14-7102-order-cancel-flow@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_ord_cancel'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  cashierToken = await signSessionToken(
    { id: 7101, userName: 'cashier_ord_cancel', roleType: 'kasir', store: location.id },
    JWT_SECRET
  )
  adminToken = await signSessionToken(
    { id: 7102, userName: 'admin_ord_cancel', roleType: 'admin', store: location.id },
    JWT_SECRET
  )
  // DR-23: reversing a paid order is an elevated void whose cash refund is
  // attributed to the open register performing it.
  await db.cashRegister.create({
    store: location.id,
    user: 7102,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these cancel-flow assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'ORD_CANCEL_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location.id }, force: true })
  await db.user.destroy({ where: { id: [7101, 7102] }, force: true })
  await db.taxConfig.destroy({ where: { store: location.id }, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.best_selling.destroy({ where: { productId: product?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('PUT /order/update-status — cancel restores stock (reverseOrderStock)', () => {
  test('cancelling a paid order restores the deducted stock', async () => {
    const createRes = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({
        store: location.id,
        items: [{ product: product.id, quantity: 5 }],
        paymentMethod: 'cash',
        cashierName: 'Test Cashier'
      })
    expect(createRes.status).toBe(201)

    const afterCreate = await db.product.findByPk(product.id)
    expect(Number(afterCreate.stock)).toBe(15)

    // DR-23 (BA §35.10 G): a PAID order is reversed by an elevated void;
    // a plain cancel is refused while money is collected.
    const cancelRes = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({
        id: createRes.body.data.id,
        status: 'cancelled',
        store: location.id,
        reason: 'Test void reason'
      })
    expect(cancelRes.status).toBe(409)
    expect(cancelRes.body.code).toBe('CANCEL_REQUIRES_VOID')
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(15)

    const voidRes = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: createRes.body.data.id, status: 'void', store: location.id, reason: 'Test void reason' })
    expect(voidRes.status).toBe(200)

    const afterCancel = await db.product.findByPk(product.id)
    expect(Number(afterCancel.stock)).toBe(20)

    const order = await db.order.findByPk(createRes.body.data.id)
    expect(order.status).toBe('void')
  })

  test('voiding a paid order sets paymentStatus refunded and a refund; re-marking it paid is rejected (F-03)', async () => {
    // Original regression intent: cancel used to leave paymentStatus stuck at
    // 'paid', so re-marking the order paid afterwards saw oldPaymentStatus ===
    // 'paid' and skipped re-deducting stock — even though cancellation had
    // just restored it. Stock ended up permanently duplicated after a single
    // cancel-then-re-pay cycle, with no concurrency involved at all.
    //
    // Phase 3 (F-03) supersedes the second half of that behavior: a cancelled/
    // refunded order is terminal — re-marking it 'paid' core-deducts stock on
    // top of an already-issued refund. The transition is now rejected with 409
    // and stock stays exactly where the cancellation left it.
    const createRes = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({
        store: location.id,
        items: [{ product: product.id, quantity: 5 }],
        paymentMethod: 'cash',
        cashierName: 'Test Cashier'
      })
    expect(createRes.status).toBe(201)
    const orderId = createRes.body.data.id

    const afterCreate = await db.product.findByPk(product.id)
    expect(Number(afterCreate.stock)).toBe(15)

    // DR-23: the paid-order reversal is an elevated void (cancel → 409).
    const cancelRes = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: orderId, status: 'void', store: location.id, reason: 'Test void reason' })
    expect(cancelRes.status).toBe(200)

    const afterCancel = await db.product.findByPk(product.id)
    expect(Number(afterCancel.stock)).toBe(20)

    const cancelledOrder = await db.order.findByPk(orderId)
    // A cancelled order that was paid must not still read paymentStatus:
    // 'paid' — that contradictory pair is exactly what let stock silently
    // duplicate below.
    expect(cancelledOrder.paymentStatus).toBe('refunded')

    const refundTxn = await db.transaction.findOne({
      where: { order: orderId, amount: { [require('sequelize').Op.lt]: 0 } }
    })
    expect(refundTxn).not.toBeNull()
    expect(Number(refundTxn.amount)).toBe(-Number(cancelledOrder.totalPrice))

    const rePaidRes = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ id: orderId, status: 'paid', store: location.id })

    // F-03: the resurrection is rejected instead of silently re-deducting.
    expect(rePaidRes.status).toBe(409)

    const afterRePaid = await db.product.findByPk(product.id)
    expect(Number(afterRePaid.stock)).toBe(20) // untouched by the rejected transition

    const still = await db.order.findByPk(orderId)
    expect(still.status).toBe('void')
    expect(still.paymentStatus).toBe('refunded')
  })

  test('cancelling a pending/unpaid order does not inflate stock that was never deducted', async () => {
    // Regression test: reverseOrderStock used to run unconditionally on
    // any cancellation, including one whose stock was never deducted in
    // the first place (e.g. a QR order awaiting split-bill payment) —
    // silently ADDING stock instead of leaving it untouched.
    const before = await db.product.findByPk(product.id)

    const pendingOrder = await db.order.create({
      orderNumber: `ORD-CANCEL-UNPAID-${Date.now()}`,
      store: location.id,
      status: 'pending',
      paymentStatus: 'unpaid',
      subTotal: 30000,
      totalQuantity: 3,
      totalPrice: 30000,
      source: 'qr'
    })
    await db.order_item.create({
      order: pendingOrder.id,
      product: product.id,
      productName: product.nameProduct,
      quantity: 3,
      price: 10000,
      totalPrice: 30000
    })

    const cancelRes = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ id: pendingOrder.id, status: 'cancelled', store: location.id })
    expect(cancelRes.status).toBe(200)

    const after = await db.product.findByPk(product.id)
    expect(Number(after.stock)).toBe(Number(before.stock))

    const cancelledOrder = await db.order.findByPk(pendingOrder.id)
    expect(cancelledOrder.status).toBe('cancelled')
    // Never paid, so nothing to refund — must stay 'unpaid', not flip to
    // 'refunded'.
    expect(cancelledOrder.paymentStatus).toBe('unpaid')

    const refundTxn = await db.transaction.findOne({ where: { order: pendingOrder.id } })
    expect(refundTxn).toBeNull()
  })
})
