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
let adminToken = null
let orderCounter = 0

const makeOrder = async ({
  qty = 1,
  totalPrice = 50000,
  paymentStatus = 'unpaid',
  status = 'pending'
} = {}) => {
  orderCounter += 1
  const order = await db.order.create({
    orderNumber: `SPL-HARD-${Date.now()}-${orderCounter}`,
    store: location.id,
    status,
    paymentStatus,
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
    price: totalPrice / qty,
    totalPrice
  })
  return order
}

beforeAll(async () => {
  location = await db.location.create({ name: 'SPL_HARD_STORE', status: 'active' })
  category = await db.category.create({ name: 'SPL_HARD_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'SPL_HARD_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 1000
  })
  await db.product_store_stock.create({
    product: product.id,
    store: location.id,
    stock: product.stock
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7401,
    userName: 'admin_spl_hard',
    email: 'p14-7401-split-bill-hardening@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_spl_hard'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7401, userName: 'admin_spl_hard', roleType: 'admin', store: location.id },
    JWT_SECRET
  )
  // P1 (DR-PAY-ATTR-02): split settlement under test requires an open register.
  await db.cashRegister.create({ store: location.id, user: 7401, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.user.destroy({ where: { id: [7401] }, force: true })
  await db.accounting_outbox.destroy({ where: { referenceType: 'order' }, force: true })
  await db.journal_entry_line.destroy({ where: {}, force: true })
  await db.journal_entry.destroy({ where: {}, force: true })
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

describe('Split bill — amount conservation', () => {
  test('splits summing to less than the total, then a second round that exactly reaches it, both succeed', async () => {
    const order = await makeOrder({ totalPrice: 100000 })

    const first = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 60000 }] })
    expect(first.status).toBe(201)

    const second = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 40000 }] })
    expect(second.status).toBe(201)

    const activeSum = await db.split_bill.sum('amount', { where: { order: order.id } })
    expect(activeSum).toBe(100000)
  })

  test('a second round that would push the active total past order.totalPrice is refused with 409, first round untouched', async () => {
    const order = await makeOrder({ totalPrice: 100000 })

    const first = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 60000 }] })
    expect(first.status).toBe(201)

    const second = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 50000 }] })
    expect(second.status).toBe(409)

    const activeSum = await db.split_bill.sum('amount', { where: { order: order.id } })
    expect(activeSum).toBe(60000)
  })

  test('three-way split of a non-divisible total (33333 x3 = 99999) is exact, no rounding drift', async () => {
    const order = await makeOrder({ totalPrice: 99999 })

    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        order: order.id,
        items: [{ amount: 33333 }, { amount: 33333 }, { amount: 33333 }]
      })
    expect(createRes.status).toBe(201)
    const [a, b, c] = createRes.body.data

    for (const split of [a, b, c]) {
      const payRes = await request(app)
        .put(`/split-bill/pay/${split.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ paymentMethod: 'cash' })
      expect(payRes.status).toBe(200)
    }

    const finalOrder = await db.order.findByPk(order.id)
    expect(finalOrder.status).toBe('paid')
    expect(finalOrder.paymentStatus).toBe('paid')

    const ledgerRows = await db.transaction.findAll({ where: { order: order.id } })
    expect(ledgerRows.reduce((sum, t) => sum + Number(t.amount), 0)).toBe(99999)
  })
})

describe('Split bill — create() idempotency', () => {
  test('replaying the same idempotencyKey with the same payload returns the original rows, no duplicates created', async () => {
    const order = await makeOrder({ totalPrice: 50000 })
    const key = 'idem-key-replay-1'

    const first = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 20000 }, { amount: 30000 }], idempotencyKey: key })
    expect(first.status).toBe(201)
    const firstIds = first.body.data.map((s) => s.id).sort()

    const replay = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 20000 }, { amount: 30000 }], idempotencyKey: key })
    expect(replay.status).toBe(200)
    const replayIds = replay.body.data.map((s) => s.id).sort()
    expect(replayIds).toEqual(firstIds)

    const allRows = await db.split_bill.findAll({ where: { order: order.id, idempotencyKey: key } })
    expect(allRows.length).toBe(2)
  })

  test('reusing the same idempotencyKey with a different payload is refused with 409', async () => {
    const order = await makeOrder({ totalPrice: 50000 })
    const key = 'idem-key-mismatch-1'

    const first = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 20000 }], idempotencyKey: key })
    expect(first.status).toBe(201)

    const mismatch = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 25000 }], idempotencyKey: key })
    expect(mismatch.status).toBe(409)

    const allRows = await db.split_bill.findAll({ where: { order: order.id, idempotencyKey: key } })
    expect(allRows.length).toBe(1)
  })

  test('two concurrent create() calls with the same idempotencyKey and payload: exactly one batch is ever created', async () => {
    const order = await makeOrder({ totalPrice: 50000 })
    const key = 'idem-key-concurrent-1'
    const payload = { order: order.id, items: [{ amount: 20000 }, { amount: 30000 }], idempotencyKey: key }

    const [r1, r2] = await Promise.all([
      request(app).post('/split-bill/create').set('Authorization', `Bearer ${adminToken}`).send(payload),
      request(app).post('/split-bill/create').set('Authorization', `Bearer ${adminToken}`).send(payload)
    ])

    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 201])

    const allRows = await db.split_bill.findAll({ where: { order: order.id, idempotencyKey: key } })
    expect(allRows.length).toBe(2)
  })
})

describe('Split bill — order-state eligibility gates', () => {
  test('create() on an already-paid order is refused with 409', async () => {
    const order = await makeOrder({ totalPrice: 50000, paymentStatus: 'paid', status: 'paid' })
    const res = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 10000 }] })
    expect(res.status).toBe(409)
  })

  test('create() on a cancelled order is refused with 409', async () => {
    const order = await makeOrder({ totalPrice: 50000, status: 'cancelled' })
    const res = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 10000 }] })
    expect(res.status).toBe(409)
  })

  test('create() on a voided order is refused with 409', async () => {
    const order = await makeOrder({ totalPrice: 50000, status: 'void' })
    const res = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 10000 }] })
    expect(res.status).toBe(409)
  })
})

describe('Split bill — replacement split scenario', () => {
  test('cancel a pending split, create a replacement, pay everything: order completes exactly once', async () => {
    const order = await makeOrder({ qty: 1, totalPrice: 50000 })

    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 20000 }, { amount: 30000 }] })
    const [splitA, splitB] = createRes.body.data

    const cancelRes = await request(app)
      .delete(`/split-bill/cancel/${splitA.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(cancelRes.status).toBe(200)

    const replacementRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 20000 }] })
    expect(replacementRes.status).toBe(201)
    const [replacement] = replacementRes.body.data

    const payB = await request(app)
      .put(`/split-bill/pay/${splitB.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'cash' })
    expect(payB.status).toBe(200)
    expect(payB.body.data.orderComplete).toBe(false)

    const payReplacement = await request(app)
      .put(`/split-bill/pay/${replacement.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'cash' })
    expect(payReplacement.status).toBe(200)
    expect(payReplacement.body.data.orderComplete).toBe(true)

    const finalOrder = await db.order.findByPk(order.id)
    expect(finalOrder.status).toBe('paid')
    expect(finalOrder.paymentStatus).toBe('paid')

    const ledgerRows = await db.transaction.findAll({ where: { order: order.id } })
    expect(ledgerRows.reduce((sum, t) => sum + Number(t.amount), 0)).toBe(50000)
  })
})

describe('Split bill — accounting outbox durability', () => {
  test('the final split payment enqueues and posts the same order journal jobs as a direct order payment', async () => {
    const order = await makeOrder({ qty: 1, totalPrice: 50000 })
    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 50000 }] })
    const [split] = createRes.body.data

    const payRes = await request(app)
      .put(`/split-bill/pay/${split.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'cash' })
    expect(payRes.status).toBe(200)
    expect(payRes.body.data.orderComplete).toBe(true)

    const outboxRows = await db.accounting_outbox.findAll({
      where: { referenceType: 'order', referenceId: order.id }
    })
    expect(outboxRows.map((r) => r.jobType).sort()).toEqual(['order_cogs_journal', 'order_journal'])
    expect(outboxRows.every((r) => r.status === 'posted')).toBe(true)

    const journalEntries = await db.journal_entry.findAll({ where: { referenceId: order.id } })
    expect(journalEntries.length).toBeGreaterThanOrEqual(1)
  })

  test('a split create()/pay() attempt that is rejected (over-total) enqueues no accounting job at all', async () => {
    const order = await makeOrder({ qty: 1, totalPrice: 50000 })

    const overRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 60000 }] })
    expect(overRes.status).toBe(409)

    const outboxRows = await db.accounting_outbox.findAll({
      where: { referenceType: 'order', referenceId: order.id }
    })
    expect(outboxRows.length).toBe(0)
  })
})

describe('Split bill — pay() and cancel() P0 race regression (named)', () => {
  test('P0 regression: concurrent pay-vs-pay on the last two splits never double-completes and never loses stock', async () => {
    const order = await makeOrder({ qty: 4, totalPrice: 40000 })
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
    const completions = [resA.body.data.orderComplete, resB.body.data.orderComplete]
    expect(completions.filter(Boolean).length).toBe(1)

    const afterStock = await db.product.findByPk(product.id)
    expect(Number(afterStock.stock)).toBe(beforeStock.stock - 4)

    const outboxRows = await db.accounting_outbox.findAll({
      where: { referenceType: 'order', referenceId: order.id }
    })
    expect(outboxRows.length).toBe(2)
  })

  test('P0 regression: cancelling the last unpaid split while its sibling is being paid never leaves the order wrongly completed', async () => {
    const order = await makeOrder({ qty: 5, totalPrice: 50000 })
    const beforeStock = await db.product.findByPk(product.id)

    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 25000 }, { amount: 25000 }] })
    const [splitA, splitB] = createRes.body.data

    const payA = await request(app)
      .put(`/split-bill/pay/${splitA.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'cash' })
    expect(payA.status).toBe(200)
    expect(payA.body.data.orderComplete).toBe(false)

    const [cancelRes, payBRes] = await Promise.all([
      request(app).delete(`/split-bill/cancel/${splitB.id}`).set('Authorization', `Bearer ${adminToken}`),
      request(app)
        .put(`/split-bill/pay/${splitB.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ paymentMethod: 'cash' })
    ])

    // Exactly one of the two can win on the same row — either the split
    // was cancelled first (pay then 404s) or paid first (cancel then 409s).
    const outcomes = [cancelRes.status, payBRes.status].sort((a, b) => a - b)
    expect([
      [200, 404],
      [200, 409]
    ]).toContainEqual(outcomes)

    const finalOrder = await db.order.findByPk(order.id)
    const finalStock = await db.product.findByPk(product.id)

    if (payBRes.status === 200 && payBRes.body.data.orderComplete) {
      // pay() won: both splits paid, order legitimately completed, stock deducted once.
      expect(finalOrder.status).toBe('paid')
      expect(Number(finalStock.stock)).toBe(beforeStock.stock - 5)
    } else {
      // cancel() won: splitB no longer exists, order must NOT be marked
      // complete/paid off of splitA alone, stock must remain untouched.
      expect(finalOrder.status).not.toBe('paid')
      expect(Number(finalStock.stock)).toBe(Number(beforeStock.stock))
    }
  })
})

// DR-24 C-10 / DR-23 §O: a split is never assumed to be paid in cash. An
// omitted (or blank) method used to book an exact-cash settlement into the
// drawer even when the diner paid with QRIS.
describe('Split bill — payment method is required (C-10)', () => {
  test.each([
    ['omitted', {}],
    ['empty', { paymentMethod: '' }],
    ['blank', { paymentMethod: '   ' }],
    ['null', { paymentMethod: null }]
  ])('a %s payment method is refused with 422 and changes nothing', async (_label, body) => {
    const order = await makeOrder({ qty: 1, totalPrice: 40000 })
    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 15000 }, { amount: 25000 }] })
    expect(createRes.status).toBe(201)
    const [split] = createRes.body.data

    const res = await request(app)
      .put(`/split-bill/pay/${split.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('PAYMENT_METHOD_REQUIRED')

    expect((await db.split_bill.findByPk(split.id)).status).toBe('pending')
    expect(await db.transaction.count({ where: { order: order.id } })).toBe(0)
    expect((await db.order.findByPk(order.id)).paymentStatus).toBe('unpaid')
  })

  test('an explicit method still pays the split', async () => {
    const order = await makeOrder({ qty: 1, totalPrice: 40000 })
    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 15000 }, { amount: 25000 }] })
    const [split] = createRes.body.data
    const res = await request(app)
      .put(`/split-bill/pay/${split.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'cash' })
    expect(res.status).toBe(200)
    const [row] = await db.transaction.findAll({ where: { order: order.id } })
    expect(row.typePayment).toBe('CASH')
    expect(Number(row.amount)).toBe(15000)
  })
})
