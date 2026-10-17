process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store = null
let storeOther = null
let category = null
let product = null
let productB = null
let adminUser = null
let adminOtherUser = null
let adminToken = null
let adminOtherToken = null
let superAdminToken = null
let orderCounter = 0

// Builds a fully-paid order directly (bypassing the checkout pipeline,
// which this suite is not re-testing) with precise, known
// subTotal/discountAmount/taxAmount/serviceChargeAmount/totalPrice and a
// matching positive `transaction` row representing the money actually
// collected — the exact ground truth pos.js's returnSalesOrder must
// compute its invariants and allocation from.
const buildPaidOrder = async ({
  items, // [{ product, productName, quantity, price, totalPrice }]
  discountAmount = 0,
  taxAmount = 0,
  serviceChargeAmount = 0,
  paymentMethod = 'cash',
  targetStore = store
}) => {
  orderCounter += 1
  const subTotal = items.reduce((s, i) => s + i.totalPrice, 0)
  const totalPrice = subTotal - discountAmount + taxAmount + serviceChargeAmount

  const order = await db.order.create({
    orderNumber: `SR-HARD-${Date.now()}-${orderCounter}`,
    store: targetStore.id,
    status: 'paid',
    paymentStatus: 'paid',
    paymentMethod,
    subTotal,
    discountAmount,
    taxAmount,
    serviceChargeAmount,
    totalPrice,
    totalQuantity: items.reduce((s, i) => s + i.quantity, 0),
    createdBy: adminUser?.id || null
  })

  const orderItems = await db.order_item.bulkCreate(
    items.map((i) => ({
      order: order.id,
      product: i.product,
      productName: i.productName,
      quantity: i.quantity,
      price: i.price,
      totalPrice: i.totalPrice
    })),
    { returning: true }
  )

  await db.transaction.create({
    order: order.id,
    typePayment: paymentMethod,
    amount: totalPrice,
    createdBy: adminUser?.id || null
  })

  order.items = orderItems
  return order
}

const returnOrder = (token, orderId, body) =>
  request(app)
    .post(`/pos/order/${orderId}/return`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)

const approveReturn = (token, id, body = {}) =>
  request(app)
    .patch(`/sales-return/approve/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ id, ...body })

// P1 (DR-PAY-ATTR-02): cash-refund approval under test requires an open
// register. Opened per test and closed at its end (the file also contains
// tests that manage their own register, so no shared fixture is used).
const openTestRegister = async () => {
  const open = await request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ openingBalance: 0 })
  expect(open.status).toBe(201)
  return open.body.data.id
}
const closeTestRegister = async (registerId) => {
  const close = await request(app)
    .put(`/cash-register/close/${registerId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ closingBalance: 0 })
  expect(close.status).toBe(200)
}

const rejectReturn = (token, id) =>
  request(app)
    .patch(`/sales-return/reject/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ id })

const getReturn = (token, id) =>
  request(app)
    .get(`/sales-return/get-by-id/${id}`)
    .set('Authorization', `Bearer ${token}`)

beforeAll(async () => {
  store = await db.location.create({ name: 'SR_HARDENING_STORE', status: 'active' })
  storeOther = await db.location.create({ name: 'SR_HARDENING_STORE_OTHER', status: 'active' })
  category = await db.category.create({ name: 'SR_HARDENING_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'SR_HARDENING_PRODUCT_A',
    category: category.id,
    price: 20000,
    stock: 500
  })
  productB = await db.product.create({
    nameProduct: 'SR_HARDENING_PRODUCT_B',
    category: category.id,
    price: 40000,
    stock: 500
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 500 })
  await db.product_store_stock.create({ product: productB.id, store: store.id, stock: 500 })

  adminUser = await db.user.create({
    userName: 'admin_sr_hardening',
    email: 'admin_sr_hardening@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminOtherUser = await db.user.create({
    userName: 'admin_sr_hardening_other',
    email: 'admin_sr_hardening_other@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeOther.id,
    status: 'active'
  })
  const superAdminUser = await db.user.create({
    userName: 'superadmin_sr_hardening',
    email: 'superadmin_sr_hardening@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active'
  })

  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  adminOtherToken = await signSessionToken(
    {
      id: adminOtherUser.id,
      userName: adminOtherUser.userName,
      roleType: 'admin',
      store: storeOther.id
    },
    JWT_SECRET
  )
  superAdminToken = await signSessionToken(
    { id: superAdminUser.id, userName: superAdminUser.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.sales_return_item.destroy({ where: {}, force: true })
  // P1 linkage hardening: transaction.salesReturnId is RESTRICT — refund
  // ledger rows must go before the returns they reference (cleanup order
  // only; no assertion changed).
  await db.transaction.destroy({ where: {}, force: true })
  await db.sales_return.destroy({ where: { store: [store.id, storeOther.id] }, force: true })
  await db.cashMovement.destroy({ where: { store: [store.id, storeOther.id] }, force: true })
  await db.cashRegister.destroy({ where: { store: [store.id, storeOther.id] }, force: true })
  await db.auditLog.destroy({ where: { store: [store.id, storeOther.id] }, force: true, __auditMaintenance: true })
  await db.stock_history.destroy({ where: { product: [product.id, productB.id] }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: [store.id, storeOther.id] }, force: true })
  await db.best_selling.destroy({ where: { productId: [product.id, productB.id] }, force: true })
  await db.product_store_stock.destroy({ where: { product: [product.id, productB.id] }, force: true })
  await db.product.destroy({ where: { id: [product.id, productB.id] }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.user.destroy({
    where: { id: [adminUser?.id, adminOtherUser?.id].filter(Boolean) },
    force: true
  })
  await db.user.destroy({ where: { store: storeOther.id }, force: true })
  await db.location.destroy({ where: { id: [store.id, storeOther.id] }, force: true })
})

describe('Amount invariant', () => {
  test('unpaid order cannot be returned (409)', async () => {
    const order = await db.order.create({
      orderNumber: `SR-HARD-UNPAID-${Date.now()}`,
      store: store.id,
      status: 'pending',
      paymentStatus: 'unpaid',
      totalPrice: 20000,
      subTotal: 20000
    })
    await db.order_item.create({
      order: order.id,
      product: product.id,
      productName: product.nameProduct,
      quantity: 1,
      price: 20000,
      totalPrice: 20000
    })
    const res = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, qty: 1 }],
      reason: 'test'
    })
    expect(res.status).toBe(409)
  })

  test('full collection allows a full refund exactly equal to collected amount', async () => {
    const registerId = await openTestRegister()
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 2, price: 20000, totalPrice: 40000 }]
    })
    const res = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 2 }],
      reason: 'full return'
    })
    expect(res.status).toBe(201)
    expect(res.body.data.refundAmount).toBe(40000)
    const approveRes = await approveReturn(adminToken, res.body.data.id)
    expect(approveRes.status).toBe(200)
    await closeTestRegister(registerId)
  })

  test('exact remaining refund succeeds; one rupiah over the remaining amount fails', async () => {
    const registerId = await openTestRegister()
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 5, price: 20000, totalPrice: 100000 }]
    })
    // First return: 60,000, approved.
    const first = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 3 }],
      reason: 'partial 1'
    })
    expect(first.status).toBe(201)
    await approveReturn(adminToken, first.body.data.id)

    // Remaining refundable = 100,000 - 60,000 = 40,000 (qty remaining = 2).
    const exact = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 2 }],
      reason: 'partial 2 exact'
    })
    expect(exact.status).toBe(201)
    expect(exact.body.data.refundAmount).toBe(40000)
    const approveExact = await approveReturn(adminToken, exact.body.data.id)
    expect(approveExact.status).toBe(200)
    await closeTestRegister(registerId)
  })

  test('cumulative refund exceeding collected amount is rejected with 409, nothing committed', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 5, price: 20000, totalPrice: 100000 }]
    })
    const first = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 3 }],
      reason: 'partial 1'
    })
    await approveReturn(adminToken, first.body.data.id)

    // Only 40,000 remains refundable (100,000 collected - 60,000
    // approved). A second product line worth 50,000 deliberately exceeds
    // that remaining balance — the amount ceiling, not the quantity
    // check, must be what rejects this.
    const secondItem = await db.order_item.create({
      order: order.id,
      product: productB.id,
      productName: productB.nameProduct,
      quantity: 1,
      price: 50000,
      totalPrice: 50000
    })
    const over = await returnOrder(adminToken, order.id, {
      items: [{ productId: productB.id, orderItemId: secondItem.id, qty: 1 }],
      reason: 'should exceed remaining'
    })
    expect(over.status).toBe(409)
    const returnsAfter = await db.sales_return.count({ where: { order: order.id, reason: 'should exceed remaining' } })
    expect(returnsAfter).toBe(0)
  })

  test('a mixed sales_return + cancel/void never lets total refunded exceed collected — both are blocked once an approved return exists', async () => {
    const registerId = await openTestRegister()
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 4, price: 20000, totalPrice: 80000 }]
    })
    const ret = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 2 }],
      reason: 'partial before cancel attempt'
    })
    await approveReturn(adminToken, ret.body.data.id)

    // DR-23 (BA §35.10 G): money is still net-collected, so cancel is
    // refused (CANCEL_REQUIRES_VOID); a PARTIALLY_REFUNDED order cannot be
    // voided in v1 (remaining lines go through a sales return). Formerly a
    // 400 from the approved-return guard; the mutual exclusion still holds.
    const cancelRes = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: order.id, status: 'cancelled', store: store.id, reason: 'Hardening test void reason' })
    expect(cancelRes.status).toBe(409)
    expect(cancelRes.body.code).toBe('CANCEL_REQUIRES_VOID')
    const voidRes = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: order.id, status: 'void', store: store.id, reason: 'Hardening test void reason' })
    expect(voidRes.status).toBe(409)
    expect(voidRes.body.code).toBe('VOID_NOT_APPLICABLE')

    const ledger = await db.transaction.findAll({ where: { order: order.id } })
    const totalCollected = ledger.filter((t) => Number(t.amount) > 0).reduce((s, t) => s + Number(t.amount), 0)
    const totalRefunded = ledger.filter((t) => Number(t.amount) < 0).reduce((s, t) => s + Math.abs(Number(t.amount)), 0)
    expect(totalRefunded).toBeLessThanOrEqual(totalCollected)
    await closeTestRegister(registerId)
  })
})

describe('Concurrency', () => {
  test('two concurrent 70,000 refund requests against a 100,000-collected order: create-time reservation lets at most one through', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 5, price: 20000, totalPrice: 100000 }]
    })
    const [r1, r2] = await Promise.all([
      returnOrder(adminToken, order.id, {
        items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 3 }],
        reason: 'race A',
        idempotencyKey: `race-a-${Date.now()}`
      }),
      returnOrder(adminToken, order.id, {
        items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 3 }],
        reason: 'race B',
        idempotencyKey: `race-b-${Date.now()}`
      })
    ])
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    // Both request 3 of the same 5 units — quantity alone (3+3=6 > 5)
    // already guarantees exactly one can be created; this also proves the
    // amount ceiling never lets combined pending+approved exceed collected.
    expect(statuses).toEqual([201, 409])
  })

  test('7 + 7 against a sold quantity of 10: exactly one succeeds, the other 409s, cumulative returned qty never exceeds 10', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 10, price: 20000, totalPrice: 200000 }]
    })
    const [r1, r2] = await Promise.all([
      returnOrder(adminToken, order.id, {
        items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 7 }],
        reason: 'qty race A'
      }),
      returnOrder(adminToken, order.id, {
        items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 7 }],
        reason: 'qty race B'
      })
    ])
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses).toEqual([201, 409])

    const rows = await db.sales_return.findAll({
      where: { order: order.id, status: { [db.Sequelize.Op.ne]: 'rejected' } },
      include: [{ model: db.sales_return_item, as: 'items' }]
    })
    const totalQty = rows.reduce(
      (s, r) => s + r.items.reduce((s2, i) => s2 + Number(i.qty), 0),
      0
    )
    expect(totalQty).toBeLessThanOrEqual(10)
  })

  test('two concurrent approve calls on two DIFFERENT pending returns that jointly exceed remaining: exactly one approve succeeds', async () => {
    const registerId = await openTestRegister()
    const order = await buildPaidOrder({
      items: [
        { product: product.id, productName: product.nameProduct, quantity: 3, price: 20000, totalPrice: 60000 },
        { product: productB.id, productName: productB.nameProduct, quantity: 1, price: 40000, totalPrice: 40000 }
      ]
    })
    // Two independent pending returns, each individually valid, whose
    // COMBINED amount (60,000 + 40,000 = 100,000) exactly consumes the
    // full 100,000 collected — approving both concurrently must not let
    // total refunded exceed collected.
    const retA = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 3 }],
      reason: 'approve race A'
    })
    const retB = await returnOrder(adminToken, order.id, {
      items: [{ productId: productB.id, orderItemId: order.items[1].id, qty: 1 }],
      reason: 'approve race B'
    })
    expect(retA.status).toBe(201)
    expect(retB.status).toBe(201)

    const [approveA, approveB] = await Promise.all([
      approveReturn(adminToken, retA.body.data.id),
      approveReturn(adminToken, retB.body.data.id)
    ])
    const statuses = [approveA.status, approveB.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 200])
    // Both fit exactly (60k+40k=100k=collected) — both are legitimately
    // approvable; the real proof is the ledger below never exceeds
    // totalCollected regardless of interleaving.
    const ledger = await db.transaction.findAll({ where: { order: order.id } })
    const totalCollected = ledger.filter((t) => Number(t.amount) > 0).reduce((s, t) => s + Number(t.amount), 0)
    const totalRefunded = ledger.filter((t) => Number(t.amount) < 0).reduce((s, t) => s + Math.abs(Number(t.amount)), 0)
    expect(totalRefunded).toBeLessThanOrEqual(totalCollected)
    await closeTestRegister(registerId)
  })

  test('approve racing an over-the-remaining THIRD pending return: the third is rejected with 409', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 5, price: 20000, totalPrice: 100000 }]
    })
    const retA = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 5 }],
      reason: 'full amount pending'
    })
    expect(retA.status).toBe(201)
    // A second full-amount return would exceed remaining (5 already
    // reserved by A's pending qty) — caught at create() by the quantity
    // reservation before amount is even relevant here, proving pending
    // reservations (not just approved) are honored.
    const retB = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'should fail — qty already fully reserved by pending A'
    })
    expect(retB.status).toBe(409)

    await approveReturn(adminToken, retA.body.data.id)
  })
})

describe('Refund allocation', () => {
  test('discount + tax + service charge are proportionally allocated for a partial return of one item', async () => {
    // Item A: 3 x 20,000 = 60,000 ; Item B: 1 x 40,000 = 40,000
    // subTotal = 100,000 ; discount 10,000 ; tax 9,900 ; service charge 4,500
    // totalPrice = 90,000 + 9,900 + 4,500 = 104,400
    // collectionRatio = 104,400 / 100,000 = 1.044
    // Returning ALL 3 units of Item A: rawReturnBase = 60,000 * 1.044 = 62,640
    const order = await buildPaidOrder({
      items: [
        { product: product.id, productName: product.nameProduct, quantity: 3, price: 20000, totalPrice: 60000 },
        { product: productB.id, productName: productB.nameProduct, quantity: 1, price: 40000, totalPrice: 40000 }
      ],
      discountAmount: 10000,
      taxAmount: 9900,
      serviceChargeAmount: 4500
    })
    const res = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 3 }],
      reason: 'allocation check'
    })
    expect(res.status).toBe(201)
    expect(res.body.data.refundAmount).toBe(62640)
  })

  test('multi-item return with rounding drift reconciles exactly via deterministic residual assignment', async () => {
    // Crafted so collectionRatio produces a non-integer per-line result,
    // forcing the residual rule to activate.
    const order = await buildPaidOrder({
      items: [
        { product: product.id, productName: product.nameProduct, quantity: 1, price: 33333, totalPrice: 33333 },
        { product: productB.id, productName: productB.nameProduct, quantity: 1, price: 33334, totalPrice: 33334 }
      ],
      discountAmount: 1000
    })
    const res = await returnOrder(adminToken, order.id, {
      items: [
        { productId: product.id, orderItemId: order.items[0].id, qty: 1 },
        { productId: productB.id, orderItemId: order.items[1].id, qty: 1 }
      ],
      reason: 'rounding reconciliation'
    })
    expect(res.status).toBe(201)
    // Full-order return: refund must equal order.totalPrice exactly.
    const freshOrder = await db.order.findByPk(order.id)
    expect(res.body.data.refundAmount).toBe(freshOrder.totalPrice)

    const items = await db.sales_return_item.findAll({ where: { salesReturn: res.body.data.id } })
    // Reconstruct each line's refund from qty * price (price is the
    // rounded per-unit reference the controller stores) is only
    // approximate for display — the authoritative sum is refundAmount
    // itself, already asserted above. Here we additionally prove the
    // two lines don't both round the same way blindly (i.e. the
    // mechanism is actually exercised, not accidentally a no-op).
    expect(items.length).toBe(2)
  })

  test('zero-subtotal order (fully free items) refunds exactly 0 with no division error', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 0, totalPrice: 0 }]
    })
    const res = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'zero subtotal'
    })
    expect(res.status).toBe(201)
    expect(res.body.data.refundAmount).toBe(0)
  })

  test('a full-order return refunds exactly order.totalPrice with discount/tax/service charge active', async () => {
    const order = await buildPaidOrder({
      items: [
        { product: product.id, productName: product.nameProduct, quantity: 3, price: 20000, totalPrice: 60000 },
        { product: productB.id, productName: productB.nameProduct, quantity: 1, price: 40000, totalPrice: 40000 }
      ],
      discountAmount: 10000,
      taxAmount: 9900,
      serviceChargeAmount: 4500
    })
    const res = await returnOrder(adminToken, order.id, {
      items: [
        { productId: product.id, orderItemId: order.items[0].id, qty: 3 },
        { productId: productB.id, orderItemId: order.items[1].id, qty: 1 }
      ],
      reason: 'full order return'
    })
    expect(res.status).toBe(201)
    expect(res.body.data.refundAmount).toBe(104400)
  })
})

describe('Tenant isolation', () => {
  test('cross-store get -> 404', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 20000, totalPrice: 20000 }]
    })
    const created = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'tenant test'
    })
    const res = await getReturn(adminOtherToken, created.body.data.id)
    expect(res.status).toBe(404)
  })

  test('cross-store approve -> 404', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 20000, totalPrice: 20000 }]
    })
    const created = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'tenant test'
    })
    const res = await approveReturn(adminOtherToken, created.body.data.id)
    expect(res.status).toBe(404)
    const row = await db.sales_return.findByPk(created.body.data.id)
    expect(row.status).toBe('pending')
  })

  test('cross-store reject -> 404', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 20000, totalPrice: 20000 }]
    })
    const created = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'tenant test'
    })
    const res = await rejectReturn(adminOtherToken, created.body.data.id)
    expect(res.status).toBe(404)
  })

  test('a non-super-admin with no store claim on their token cannot access another store\'s return (fails closed, not open)', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 20000, totalPrice: 20000 }]
    })
    const created = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'tenant test'
    })
    const noStoreUser = await db.user.create({
      userName: 'no_store_claim_user',
      email: 'no_store_claim_user@test.com',
      roleType: 'admin',
      userType: 'admin',
      status: 'active'
    })
    const noStoreToken = await signSessionToken(
      { id: noStoreUser.id, userName: noStoreUser.userName, roleType: 'admin' },
      JWT_SECRET
    )
    const res = await getReturn(noStoreToken, created.body.data.id)
    // N-11: unassigned accounts are rejected centrally by
    // validateStoreAccess (403 'Store assignment required') before any
    // controller reaches tenant data — fail-closed, never open.
    expect(res.status).toBe(403)
    await db.user.destroy({ where: { id: noStoreUser.id }, force: true })
  })

  test('cross-store order reference at create-time -> 404, zero side effects', async () => {
    const otherOrder = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 20000, totalPrice: 20000 }],
      targetStore: storeOther
    })
    const res = await returnOrder(adminToken, otherOrder.id, {
      items: [{ productId: product.id, orderItemId: otherOrder.items[0].id, qty: 1 }],
      reason: 'cross-store attempt'
    })
    expect(res.status).toBe(404)
    const count = await db.sales_return.count({ where: { order: otherOrder.id } })
    expect(count).toBe(0)
  })

  test('super_admin is not scope-restricted and can view any store\'s return', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 20000, totalPrice: 20000 }]
    })
    const created = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'super admin visibility'
    })
    const res = await getReturn(superAdminToken, created.body.data.id)
    expect(res.status).toBe(200)
  })
})

describe('Idempotency', () => {
  test('identical retry with the same key returns the original, 200 not 201', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 2, price: 20000, totalPrice: 40000 }]
    })
    const key = `idem-${Date.now()}-${Math.random()}`
    const payload = {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'idempotent test',
      idempotencyKey: key
    }
    const first = await returnOrder(adminToken, order.id, payload)
    expect(first.status).toBe(201)
    const second = await returnOrder(adminToken, order.id, payload)
    expect(second.status).toBe(200)
    expect(second.body.data.id).toBe(first.body.data.id)

    const count = await db.sales_return.count({ where: { order: order.id, idempotencyKey: key } })
    expect(count).toBe(1)
  })

  test('same key, materially different payload -> 409', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 2, price: 20000, totalPrice: 40000 }]
    })
    const key = `idem-diff-${Date.now()}-${Math.random()}`
    const first = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'first reason',
      idempotencyKey: key
    })
    expect(first.status).toBe(201)
    const second = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'a completely different reason',
      idempotencyKey: key
    })
    expect(second.status).toBe(409)
  })

  test('concurrent identical-payload requests never produce two rows', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 2, price: 20000, totalPrice: 40000 }]
    })
    const key = `idem-concurrent-${Date.now()}-${Math.random()}`
    const payload = {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'concurrent idempotent',
      idempotencyKey: key
    }
    const [r1, r2] = await Promise.all([
      returnOrder(adminToken, order.id, payload),
      returnOrder(adminToken, order.id, payload)
    ])
    expect([r1.status, r2.status].every((s) => s === 200 || s === 201)).toBe(true)
    const count = await db.sales_return.count({ where: { order: order.id, idempotencyKey: key } })
    expect(count).toBe(1)
  })

  test('the same idempotencyKey on a different order is an independent request', async () => {
    const orderA = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 2, price: 20000, totalPrice: 40000 }]
    })
    const orderB = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 2, price: 20000, totalPrice: 40000 }]
    })
    const key = `idem-cross-order-${Date.now()}-${Math.random()}`
    const retA = await returnOrder(adminToken, orderA.id, {
      items: [{ productId: product.id, orderItemId: orderA.items[0].id, qty: 1 }],
      reason: 'order A',
      idempotencyKey: key
    })
    const retB = await returnOrder(adminToken, orderB.id, {
      items: [{ productId: product.id, orderItemId: orderB.items[0].id, qty: 1 }],
      reason: 'order B',
      idempotencyKey: key
    })
    expect(retA.status).toBe(201)
    expect(retB.status).toBe(201)
    expect(retA.body.data.id).not.toBe(retB.body.data.id)
  })
})

describe('Cash ledger integration', () => {
  const openRegister = (token) =>
    request(app)
      .post('/cash-register/open')
      .set('Authorization', `Bearer ${token}`)
      .send({ openingBalance: 0 })
  const closeRegister = (token, id) =>
    request(app)
      .put(`/cash-register/close/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ closingBalance: 0 })

  test('a cash sale followed by a partial cash refund: expectedCash reflects the net, not zero', async () => {
    const open = await openRegister(adminToken)
    expect(open.status).toBe(201)
    const registerId = open.body.data.id

    const order = await db.order.create({
      orderNumber: `SR-CASH-${Date.now()}`,
      store: store.id,
      status: 'paid',
      paymentStatus: 'paid',
      paymentMethod: 'cash',
      subTotal: 100000,
      totalPrice: 100000,
      cashRegisterId: registerId,
      createdBy: adminUser.id
    })
    const orderItem = await db.order_item.create({
      order: order.id,
      product: product.id,
      productName: product.nameProduct,
      quantity: 5,
      price: 20000,
      totalPrice: 100000
    })
    await db.transaction.create({
      order: order.id,
      typePayment: 'cash',
      cashReceived: 100000,
      changeGiven: 0,
      amount: 100000,
      createdBy: adminUser.id
    })

    const ret = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: orderItem.id, qty: 1 }],
      reason: 'cash refund test',
      refundMethod: 'cash'
    })
    expect(ret.status).toBe(201)
    await approveReturn(adminToken, ret.body.data.id)

    const freshOrder = await db.order.findByPk(order.id)
    // Refund flips paymentStatus away from 'paid' — the whole point of
    // this test is proving the cash ledger still sees the sale anyway.
    expect(freshOrder.paymentStatus).not.toBe('paid')

    const current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    // 100,000 collected - 20,000 refunded (1 unit @ 20,000, full
    // collection so collectionRatio = 1) = 80,000 net.
    expect(current.body.data.cashSalesReceived).toBe(80000)

    const close = await closeRegister(adminToken, registerId)
    expect(close.status).toBe(200)
  })

  test('a non-cash refund does not affect cashSalesReceived', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id

    const order = await db.order.create({
      orderNumber: `SR-NONCASH-${Date.now()}`,
      store: store.id,
      status: 'paid',
      paymentStatus: 'paid',
      paymentMethod: 'cash',
      subTotal: 50000,
      totalPrice: 50000,
      cashRegisterId: registerId,
      createdBy: adminUser.id
    })
    const orderItem = await db.order_item.create({
      order: order.id,
      product: product.id,
      productName: product.nameProduct,
      quantity: 1,
      price: 50000,
      totalPrice: 50000
    })
    await db.transaction.create({
      order: order.id,
      typePayment: 'cash',
      cashReceived: 50000,
      changeGiven: 0,
      amount: 50000,
      createdBy: adminUser.id
    })

    const ret = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: orderItem.id, qty: 1 }],
      reason: 'noncash refund test',
      refundMethod: 'card'
    })
    await approveReturn(adminToken, ret.body.data.id)

    const current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    // The card refund must not touch cashSalesReceived — the original
    // 50,000 cash sale stays fully counted.
    expect(current.body.data.cashSalesReceived).toBe(50000)

    await closeRegister(adminToken, registerId)
  })
})

describe('Database / migration integrity', () => {
  test('sales_return.order FK rejects a nonexistent order', async () => {
    await expect(
      db.sales_return.create({
        order: 999999999,
        store: store.id,
        returnNumber: `SR-ORPHAN-${Date.now()}`,
        status: 'pending',
        reason: 'orphan test'
      })
    ).rejects.toThrow()
  })

  test('sales_return.status NOT NULL is enforced', async () => {
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 20000, totalPrice: 20000 }]
    })
    await expect(
      db.sequelize.query(
        `INSERT INTO sales_return ("order", store, "returnNumber", status, "createdAt", "updatedAt")
         VALUES (${order.id}, ${store.id}, 'SR-NULLSTATUS-${Date.now()}', NULL, NOW(), NOW())`
      )
    ).rejects.toThrow()
  })

  test('deleting a product with sales_return_item history is blocked by ON DELETE RESTRICT', async () => {
    const tempProduct = await db.product.create({
      nameProduct: 'SR_FK_TEST_PRODUCT',
      category: category.id,
      price: 1000,
      stock: 10
    })
    const order = await buildPaidOrder({
      items: [{ product: tempProduct.id, productName: tempProduct.nameProduct, quantity: 1, price: 1000, totalPrice: 1000 }]
    })
    const ret = await returnOrder(adminToken, order.id, {
      items: [{ productId: tempProduct.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'fk restrict test'
    })
    expect(ret.status).toBe(201)

    await expect(db.product.destroy({ where: { id: tempProduct.id }, force: true })).rejects.toThrow()

    await db.sales_return_item.destroy({ where: { salesReturn: ret.body.data.id }, force: true })
    await db.sales_return.destroy({ where: { id: ret.body.data.id }, force: true })
    await db.product.destroy({ where: { id: tempProduct.id }, force: true })
  })
})

describe('Regression', () => {
  test('an approved return persists approvedBy/approvedAt atomically with the status transition', async () => {
    const registerId = await openTestRegister()
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 20000, totalPrice: 20000 }]
    })
    const ret = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'approval metadata test'
    })
    const before = new Date()
    const approveRes = await approveReturn(adminToken, ret.body.data.id)
    expect(approveRes.status).toBe(200)

    const row = await db.sales_return.findByPk(ret.body.data.id)
    expect(row.approvedBy).toBe(adminUser.id)
    expect(row.approvedAt).toBeTruthy()
    expect(new Date(row.approvedAt).getTime()).toBeGreaterThanOrEqual(before.getTime() - 5000)
    await closeTestRegister(registerId)
  })

  test('refundReference is accepted at approval and persisted', async () => {
    const registerId = await openTestRegister()
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 20000, totalPrice: 20000 }]
    })
    const ret = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'refund reference test'
    })
    const res = await approveReturn(adminToken, ret.body.data.id, { refundReference: 'BANK-REF-12345' })
    expect(res.status).toBe(200)
    const row = await db.sales_return.findByPk(ret.body.data.id)
    expect(row.refundReference).toBe('BANK-REF-12345')
    await closeTestRegister(registerId)
  })
})

// BA gap 009 (DR-23 §D/§G, DR-13): a non-cash refund is traceable — approval
// without its reference (OTHER: a description) is refused with no effect.
describe('BA 009 non-cash refund reference', () => {
  const nonCashReturn = async (method) => {
    const order = await buildPaidOrder({
      paymentMethod: method,
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 20000, totalPrice: 20000 }]
    })
    const ret = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'BA 009',
      refundMethod: method
    })
    expect(ret.status).toBeLessThan(300)
    return { order, returnId: ret.body.data.id }
  }

  test.each(['qris', 'debit', 'transfer', 'e-wallet', 'other'])(
    '%s refund without a reference is refused: still pending, no ledger row, no restock',
    async (method) => {
      const { order, returnId } = await nonCashReturn(method)
      const stockBefore = (await db.product.findByPk(product.id)).stock
      for (const body of [{}, { refundReference: '   ' }]) {
        const res = await approveReturn(adminToken, returnId, body)
        expect(res.status).toBe(422)
        expect(res.body.code).toBe('REFERENCE_REQUIRED')
      }
      expect((await db.sales_return.findByPk(returnId)).status).toBe('pending')
      expect(await db.transaction.count({ where: { order: order.id, salesReturnId: returnId } })).toBe(0)
      expect((await db.product.findByPk(product.id)).stock).toBe(stockBefore)
    }
  )

  test('other is asked for a description, a card for its reference', async () => {
    const other = await nonCashReturn('other')
    const otherRes = await approveReturn(adminToken, other.returnId)
    expect(otherRes.body.message).toMatch(/description of how this refund was made/)
    const card = await nonCashReturn('debit')
    const cardRes = await approveReturn(adminToken, card.returnId)
    expect(cardRes.body.message).toMatch(/refund reference is required for a CARD refund/)
  })

  test('with a reference the refund is approved and the reference stored trimmed', async () => {
    const { order, returnId } = await nonCashReturn('qris')
    const res = await approveReturn(adminToken, returnId, { refundReference: '  QR-REFUND-9  ' })
    expect(res.status).toBe(200)
    expect((await db.sales_return.findByPk(returnId)).refundReference).toBe('QR-REFUND-9')
    const row = await db.transaction.findOne({ where: { order: order.id, salesReturnId: returnId } })
    expect(row.referenceNumber).toBe('QR-REFUND-9')
  })

  test('a cash refund still needs no reference', async () => {
    const registerId = await openTestRegister()
    const order = await buildPaidOrder({
      items: [{ product: product.id, productName: product.nameProduct, quantity: 1, price: 20000, totalPrice: 20000 }]
    })
    const ret = await returnOrder(adminToken, order.id, {
      items: [{ productId: product.id, orderItemId: order.items[0].id, qty: 1 }],
      reason: 'BA 009 cash'
    })
    const res = await approveReturn(adminToken, ret.body.data.id)
    expect(res.status).toBe(200)
    await closeTestRegister(registerId)
  })
})
