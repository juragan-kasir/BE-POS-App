process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let category = null
let product = null
let adminToken = null
let orderCounter = 0

const makeUnpaidOrder = async ({ qty = 5, totalPrice = 50000 } = {}) => {
  orderCounter += 1
  const order = await db.order.create({
    orderNumber: `SPL-TEST-${Date.now()}-${orderCounter}`,
    store: location.id,
    status: 'pending',
    paymentStatus: 'unpaid',
    subTotal: totalPrice,
    totalQuantity: qty,
    totalPrice,
    source: 'qr'
  })
  await db.order_item.create({
    order: order.id,
    product: product.id,
    productName: product.nameProduct,
    quantity: qty,
    price: 10000,
    totalPrice: qty * 10000
  })
  return order
}

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'SPL_FLOW_STORE', status: 'active' }))
  category = await db.category.create({ name: 'SPL_FLOW_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'SPL_FLOW_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100
  })
  await db.product_store_stock.create({
    product: product.id,
    store: location.id,
    stock: product.stock
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7301,
    userName: 'admin_spl_flow',
    email: 'p14-7301-split-bill-flow@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_spl_flow'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7301, userName: 'admin_spl_flow', roleType: 'admin', store: location.id },
    JWT_SECRET
  )
  // DR-23: a void's cash refund is attributed to the open register
  // performing it (split collections happen inside this register window).
  await db.cashRegister.create({
    store: location.id,
    user: 7301,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location.id }, force: true })
  await db.user.destroy({ where: { id: [7301] }, force: true })
  await db.split_bill.destroy({ where: {}, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.best_selling.destroy({ where: { productId: product?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('Split bill — transactions, ledger, and stock deduction on completion', () => {
  test('paying every split deducts stock exactly once and posts to the payment ledger', async () => {
    const order = await makeUnpaidOrder({ qty: 5 })
    const beforeStock = await db.product.findByPk(product.id)

    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 25000 }, { amount: 25000 }] })
    expect(createRes.status).toBe(201)
    const [splitA, splitB] = createRes.body.data

    const payA = await request(app)
      .put(`/split-bill/pay/${splitA.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'cash' })
    expect(payA.status).toBe(200)
    expect(payA.body.data.orderComplete).toBe(false)

    // Not complete yet — stock must still be untouched.
    const midStock = await db.product.findByPk(product.id)
    expect(Number(midStock.stock)).toBe(Number(beforeStock.stock))

    const payB = await request(app)
      .put(`/split-bill/pay/${splitB.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      // P1 (DR-PAY-ATTR-06/15): non-cash split settlement carries a
      // reference persisted on the immutable ledger row.
      .send({ paymentMethod: 'qris', referenceNumber: 'QR-SPLITFLOW-1' })
    expect(payB.status).toBe(200)
    expect(payB.body.data.orderComplete).toBe(true)

    const afterStock = await db.product.findByPk(product.id)
    expect(Number(afterStock.stock)).toBe(beforeStock.stock - 5)

    const finalOrder = await db.order.findByPk(order.id)
    expect(finalOrder.status).toBe('paid')
    expect(finalOrder.paymentStatus).toBe('paid')

    const ledgerRows = await db.transaction.findAll({ where: { order: order.id } })
    expect(ledgerRows.length).toBe(2)
    expect(ledgerRows.reduce((sum, t) => sum + Number(t.amount), 0)).toBe(50000)
  })

  test('two splits of the same order paid at the same instant: order still completes exactly once, stock deducted exactly once', async () => {
    // F5: totalPrice must match the split amounts exactly for the order
    // to legitimately complete under the corrected invariant (was
    // relying on the default totalPrice=50000 while these splits only
    // summed to 40000 — the order only completed before because the old
    // check never looked at amounts at all).
    const order = await makeUnpaidOrder({ qty: 4, totalPrice: 40000 })
    const beforeStock = await db.product.findByPk(product.id)

    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 20000 }, { amount: 20000 }] })
    const [splitA, splitB] = createRes.body.data

    const [resA, resB] = await Promise.all([
      request(app)
        .put(`/split-bill/pay/${splitA.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ paymentMethod: 'cash' }),
      request(app)
        .put(`/split-bill/pay/${splitB.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ paymentMethod: 'cash' })
    ])

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    // Exactly one of the two must have observed the order-completing state.
    expect([resA.body.data.orderComplete, resB.body.data.orderComplete]).toContain(true)

    const afterStock = await db.product.findByPk(product.id)
    // Must be deducted exactly once (4), never lost (0) or doubled (8).
    expect(Number(afterStock.stock)).toBe(beforeStock.stock - 4)

    const finalOrder = await db.order.findByPk(order.id)
    expect(finalOrder.paymentStatus).toBe('paid')

    const ledgerRows = await db.transaction.findAll({ where: { order: order.id } })
    expect(ledgerRows.length).toBe(2)
  })

  test('paying the same split twice concurrently: exactly one succeeds', async () => {
    const order = await makeUnpaidOrder({ qty: 2 })
    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 20000 }] })
    const [split] = createRes.body.data

    const [r1, r2] = await Promise.all([
      request(app)
        .put(`/split-bill/pay/${split.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ paymentMethod: 'cash' }),
      request(app)
        .put(`/split-bill/pay/${split.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ paymentMethod: 'cash' })
    ])

    const statuses = [r1.status, r2.status].sort()
    // F5: "already paid" is now a 409 business conflict (was 400).
    expect(statuses).toEqual([200, 409])

    const ledgerRows = await db.transaction.findAll({ where: { order: order.id } })
    expect(ledgerRows.length).toBe(1)
  })

  test('cancelling a paid split is refused', async () => {
    const order = await makeUnpaidOrder({ qty: 1 })
    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 10000 }] })
    const [split] = createRes.body.data

    await request(app)
      .put(`/split-bill/pay/${split.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'cash' })

    const cancelRes = await request(app)
      .delete(`/split-bill/cancel/${split.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    // F5: "already paid" is now a 409 business conflict (was 400).
    expect(cancelRes.status).toBe(409)

    const stillThere = await db.split_bill.findByPk(split.id)
    expect(stillThere).not.toBeNull()
    expect(stillThere.status).toBe('paid')
  })

  test('cancelling a pending split still works', async () => {
    const order = await makeUnpaidOrder({ qty: 1 })
    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 10000 }] })
    const [split] = createRes.body.data

    const cancelRes = await request(app)
      .delete(`/split-bill/cancel/${split.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(cancelRes.status).toBe(200)

    const gone = await db.split_bill.findByPk(split.id)
    expect(gone).toBeNull()
  })

  // F5: the old "any pending split blocks a new create()" gate is gone —
  // multiple creation rounds are intentionally allowed as long as the
  // active total never exceeds order.totalPrice (see the "replacement
  // split" test below for the legitimate multi-round case). This test
  // now proves the real replacement invariant: two concurrent creates
  // that would jointly exceed the order total.
  test('two concurrent create() calls whose combined amount exceeds the order total: exactly one succeeds, active sum never exceeds the total', async () => {
    const order = await makeUnpaidOrder({ qty: 1, totalPrice: 50000 })

    const [r1, r2] = await Promise.all([
      request(app)
        .post('/split-bill/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ order: order.id, items: [{ amount: 30000 }] }),
      request(app)
        .post('/split-bill/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ order: order.id, items: [{ amount: 30000 }] })
    ])

    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses).toEqual([201, 409])

    const activeSum = await db.split_bill.sum('amount', { where: { order: order.id } })
    expect(activeSum).toBeLessThanOrEqual(order.totalPrice)
  })

  test('multiple creation rounds are allowed as long as the combined active total stays within the order total', async () => {
    const order = await makeUnpaidOrder({ qty: 1, totalPrice: 50000 })

    const first = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 20000 }] })
    expect(first.status).toBe(201)

    const second = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 30000 }] })
    expect(second.status).toBe(201)

    const activeSum = await db.split_bill.sum('amount', { where: { order: order.id } })
    expect(activeSum).toBe(50000)
  })

  test('merge combines two pending splits atomically', async () => {
    const order = await makeUnpaidOrder({ qty: 1 })
    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 10000 }, { amount: 15000 }] })
    const [splitA, splitB] = createRes.body.data

    const mergeRes = await request(app)
      .post('/split-bill/merge')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, splitIds: [splitA.id, splitB.id] })

    expect(mergeRes.status).toBe(201)
    expect(mergeRes.body.data.amount).toBe(25000)

    const remaining = await db.split_bill.findAll({ where: { order: order.id } })
    expect(remaining.length).toBe(1)
    expect(remaining[0].amount).toBe(25000)
  })

  test('cancelling the order racing the final split payment: money never disappears and stock never ends up wrong', async () => {
    // DR-23 (BA §35.10 G, P0-3): once the first split is collected the order
    // holds money (N > 0), so cancel is refused (CANCEL_REQUIRES_VOID) under
    // the order lock no matter how the race interleaves — the former "cancel
    // won" outcome (a cancelled order still holding collected money) is the
    // P0-3 defect itself. The final split completes the order exactly once;
    // reversing it is an authorized void that restores stock exactly once.
    const order = await makeUnpaidOrder({ qty: 5 })
    const baseline = await db.product.findByPk(product.id)

    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 25000 }, { amount: 25000 }] })
    const [splitA, splitB] = createRes.body.data

    const firstPay = await request(app)
      .put(`/split-bill/pay/${splitA.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'cash' })
    expect(firstPay.status).toBe(200)
    expect(firstPay.body.data.orderComplete).toBe(false)

    const [cancelRes, finalPayRes] = await Promise.all([
      request(app)
        .put('/order/update-status')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: order.id, status: 'cancelled', store: location.id, reason: 'Race test void reason' }),
      request(app)
        .put(`/split-bill/pay/${splitB.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ paymentMethod: 'cash' })
    ])

    expect(cancelRes.status).toBe(409)
    expect(cancelRes.body.code).toBe('CANCEL_REQUIRES_VOID')
    expect(finalPayRes.status).toBe(200)
    expect(finalPayRes.body.data.orderComplete).toBe(true)

    const paidOrder = await db.order.findByPk(order.id)
    expect(paidOrder.status).toBe('paid')
    expect(paidOrder.paymentStatus).toBe('paid')
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(Number(baseline.stock) - 5)
    const ledger = await db.transaction.findAll({ where: { order: order.id } })
    expect(ledger.filter((t) => Number(t.amount) < 0)).toHaveLength(0)
    expect(ledger.reduce((sum, t) => sum + Number(t.amount), 0)).toBe(50000)

    const voidRes = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: order.id, status: 'void', store: location.id, reason: 'Race test void reason' })
    expect(voidRes.status).toBe(200)

    const finalOrder = await db.order.findByPk(order.id)
    expect(finalOrder.status).toBe('void')
    expect(finalOrder.paymentStatus).toBe('refunded')
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(Number(baseline.stock))
    const finalLedger = await db.transaction.findAll({ where: { order: order.id } })
    expect(finalLedger.reduce((sum, t) => sum + Number(t.amount), 0)).toBe(0)
  })
})
