process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BA §35.10 / DR-23 — Payment & Settlement P0 financial-integrity core.
//
//   P0-1  no under-settlement: a settlement must equal the CURRENT
//         outstanding amount; an old full-order total never bypasses it.
//   P0-2  no duplicate collection: a pending split is never payable once the
//         order is PAID, cancelled, void or REFUNDED.
//   P0-3  money never disappears: cancel is refused while money is net
//         collected; void (elevated) refunds exactly what was collected.
//
// Every assertion is made against an independent ledger oracle (G/V/P/C/R/
// N/O recomputed here from raw rows), never against the implementation's
// own aggregate helper.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const UNIT_PRICE = 25000
const QTY = 4
const G = UNIT_PRICE * QTY // 100,000
const POINTS_PER_UNIT = 5

let store = null
let storeNoRegister = null
let storeRotating = null
let category = null
let product = null
let adminToken = null
let kasirToken = null
let adminNoRegToken = null
let adminRotToken = null
let adminUser = null
let registerId = null
const createdTableIds = []
const createdMemberIds = []
const storeIds = () => [store?.id, storeNoRegister?.id, storeRotating?.id].filter(Boolean)

async function makeTable(storeId) {
  const t = await db.table.create({ store: storeId, name: unique('P0_TABLE') })
  createdTableIds.push(t.id)
  return t
}

async function makeMember(storeId) {
  const m = await db.member.create({
    name: unique('P0_MEMBER'),
    phoneNumber: `08${Math.floor(1e9 + Math.random() * 9e9)}`,
    store: storeId,
    totalPoints: 0,
    lifetimePoints: 0,
    status: 'active'
  })
  createdMemberIds.push(m.id)
  return m
}

// Real BISA/QR order: created unpaid, G = 100,000, settled later.
async function makeQrOrder({ storeId = store.id, customerId } = {}) {
  const table = await makeTable(storeId)
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: storeId,
      tableId: table.id,
      customerName: 'P0 QR',
      ...(customerId ? { customerId } : {}),
      items: [{ productId: product.id, productName: product.nameProduct, quantity: QTY }],
      idempotencyKey: unique('p0qr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  expect(Number(res.body.data.totalPrice)).toBe(G)
  return res.body.data
}

const auth = (token) => ({ Authorization: `Bearer ${token}` })

const updateStatus = (token, body) =>
  request(app).put('/order/update-status').set(auth(token)).send(body)

const createSplits = (orderId, amounts, token = adminToken) =>
  request(app)
    .post('/split-bill/create')
    .set(auth(token))
    .send({ order: orderId, items: amounts.map((amount) => ({ amount })) })

const paySplit = (splitId, token = adminToken, paymentMethod = 'cash') =>
  request(app).put(`/split-bill/pay/${splitId}`).set(auth(token)).send({ paymentMethod })

// ---- independent ledger oracle (BA §35.10 B/C) ---------------------------

async function oracle(orderId) {
  const order = await db.order.findByPk(orderId)
  const rows = await db.transaction.findAll({ where: { order: orderId } })
  const Gv = Number(order.totalPrice) || 0
  const C = rows.filter((r) => Number(r.amount) > 0).reduce((s, r) => s + Number(r.amount), 0)
  const R = rows.filter((r) => Number(r.amount) < 0).reduce((s, r) => s + Math.abs(Number(r.amount)), 0)
  const returns = await db.sales_return.findAll({ where: { order: orderId, status: 'approved' } })
  const terminal = ['cancelled', 'void'].includes(order.status)
  const V = terminal ? Gv : Math.min(Gv, returns.reduce((s, r) => s + Number(r.refundAmount || 0), 0))
  const P = Gv - V
  const N = C - R
  const O = P - C + R
  let state
  if (O < 0 || (R > 0 && O > 0) || R > C) state = 'INVALID'
  else if (C === 0 && R === 0) state = Gv === 0 && !terminal ? 'PAID' : 'UNPAID'
  else if (R === 0) state = O > 0 ? 'PARTIALLY_PAID' : 'PAID'
  else state = N === 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
  return { G: Gv, V, P, C, R, N, O, state, order, rows }
}

async function stockNow() {
  const pss = await db.product_store_stock.findOne({ where: { product: product.id, store: store.id } })
  return Number(pss.stock)
}

async function snapshot(orderId, memberId = null) {
  const order = await db.order.findByPk(orderId)
  const txns = await db.transaction.findAll({ where: { order: orderId }, order: [['id', 'ASC']] })
  const splits = await db.split_bill.findAll({
    where: { order: orderId },
    paranoid: false,
    order: [['id', 'ASC']]
  })
  const outbox = await db.accounting_outbox.count({ where: { referenceType: 'order', referenceId: orderId } })
  const pointRows = memberId
    ? await db.member_point_history.count({ where: { member: memberId } })
    : null
  const member = memberId ? await db.member.findByPk(memberId) : null
  const saleHistory = await db.stock_history.count({ where: { referenceId: orderId, referenceType: ['sale', 'sale_reversal'] } })
  return {
    status: order.status,
    paymentStatus: order.paymentStatus,
    cashRegisterId: order.cashRegisterId,
    txns: txns.map((t) => [t.id, Number(t.amount), t.typePayment]),
    splits: splits.map((s) => [s.id, s.status, Number(s.amount), s.deletedAt ? 'deleted' : 'live']),
    outbox,
    pointRows,
    memberPoints: member ? Number(member.totalPoints) : null,
    saleHistory,
    stock: await stockNow()
  }
}

async function auditFor(entity, entityId) {
  return db.auditLog.findAll({ where: { entity, entityId: String(entityId) }, order: [['id', 'ASC']] })
}

// A partially-paid order: G = 100,000, a paid cash split of 20,000 and a
// pending split of 80,000 (the P0-1 / P0-3 fixture).
async function makePartiallyPaid({ storeId = store.id, customerId } = {}) {
  const order = await makeQrOrder({ storeId, customerId })
  const splitRes = await createSplits(order.id, [20000, 80000], storeId === store.id ? adminToken : adminNoRegToken)
  expect(splitRes.status).toBe(201)
  const [paid, pending] = splitRes.body.data
  const payRes = await paySplit(paid.id, storeId === store.id ? adminToken : adminNoRegToken)
  expect(payRes.status).toBe(200)
  return { order, paidSplit: paid, pendingSplit: pending }
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('P0_STORE'), status: 'active' })
  storeNoRegister = await db.location.create({ name: unique('P0_NOREG'), status: 'active' })
  storeRotating = await db.location.create({ name: unique('P0_ROT'), status: 'active' })
  category = await db.category.create({ name: unique('P0_CAT') })
  product = await db.product.create({
    nameProduct: unique('P0_PRODUCT'),
    category: category.id,
    price: UNIT_PRICE,
    point: POINTS_PER_UNIT,
    stock: 10000
  })
  for (const s of storeIds()) {
    await db.product_store_stock.create({ product: product.id, store: s, stock: 10000 })
    // Explicit 0% PPN (valid under W3-3) keeps G exactly 100,000.
    await db.taxConfig.create({ store: s, name: unique('P0_PPN'), rate: 0, type: 'ppn', status: 'active' })
  }

  const mkUser = async (roleType, storeId) =>
    db.user.create({
      userName: unique(`p0_${roleType}`),
      email: `${unique(`p0_${roleType}`)}@test.com`,
      roleType,
      userType: roleType,
      store: storeId,
      status: 'active'
    })
  const tokenFor = (u) =>
    signSessionToken({ id: u.id, userName: u.userName, roleType: u.roleType, store: u.store }, JWT_SECRET)

  adminUser = await mkUser('admin', store.id)
  adminToken = await tokenFor(adminUser)
  kasirToken = await tokenFor(await mkUser('kasir', store.id))
  adminNoRegToken = await tokenFor(await mkUser('admin', storeNoRegister.id))
  adminRotToken = await tokenFor(await mkUser('admin', storeRotating.id))

  const openRes = await request(app)
    .post('/cash-register/open')
    .set(auth(adminToken))
    .send({ store: store.id, openingBalance: 0, shift: 1 })
  if (![200, 201].includes(openRes.status)) throw new Error('register setup failed: ' + JSON.stringify(openRes.body))
  registerId = openRes.body.data.id
})

afterAll(async () => {
  const orders = await db.order.findAll({ where: { store: storeIds() }, paranoid: false, attributes: ['id'] })
  const orderIds = orders.map((o) => o.id)
  await db.split_bill.destroy({ where: { order: orderIds }, force: true })
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.accounting_outbox.destroy({ where: { referenceType: 'order', referenceId: orderIds } })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.member_point_history.destroy({ where: { member: createdMemberIds }, force: true })
  await db.member.destroy({ where: { id: createdMemberIds }, force: true })
  await db.cashMovement.destroy({ where: { store: storeIds() }, force: true })
  await db.cashRegister.destroy({ where: { store: storeIds() }, force: true })
  await db.best_selling.destroy({ where: { store: storeIds() }, force: true })
  await db.stock_history.destroy({ where: { store: storeIds() }, force: true })
  await db.product_store_stock.destroy({ where: { store: storeIds() }, force: true })
  await db.taxConfig.destroy({ where: { store: storeIds() }, force: true })
  await db.table.destroy({ where: { id: createdTableIds }, force: true })
  await db.user.destroy({ where: { store: storeIds() }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: storeIds() }, force: true })
})

// ---------------------------------------------------------------------------
describe('P0 state model — partial payment is first-class', () => {
  test('P0-S1. unpaid → partial split payment yields PARTIALLY_PAID (never "unpaid")', async () => {
    const { order } = await makePartiallyPaid()
    const o = await oracle(order.id)
    expect(o).toMatchObject({ G, C: 20000, R: 0, O: 80000, state: 'PARTIALLY_PAID' })
    // Legacy cache carrier (no migration): PARTIALLY_PAID ↦ 'partial'.
    expect(o.order.paymentStatus).toBe('partial')
  })
})

// ---------------------------------------------------------------------------
describe('P0-1 — no under-settlement / stale outstanding', () => {
  test('P0-1A. legacy full settlement without an amount is refused against outstanding 80,000', async () => {
    const member = await makeMember(store.id)
    const { order, pendingSplit } = await makePartiallyPaid({ customerId: member.id })
    const before = await snapshot(order.id, member.id)

    const res = await updateStatus(adminToken, { id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('OUTSTANDING_CHANGED')

    expect(await snapshot(order.id, member.id)).toEqual(before)
    const o = await oracle(order.id)
    expect(o).toMatchObject({ C: 20000, O: 80000, state: 'PARTIALLY_PAID' })
    const split = await db.split_bill.findByPk(pendingSplit.id)
    expect(split.status).toBe('pending')
  })

  test('P0-1B. explicit amount = old full total (100,000) is refused identically', async () => {
    const member = await makeMember(store.id)
    const { order, pendingSplit } = await makePartiallyPaid({ customerId: member.id })
    const before = await snapshot(order.id, member.id)

    const res = await updateStatus(adminToken, {
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      amount: G
    })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('OUTSTANDING_CHANGED')
    expect(res.body.outstanding).toBe(80000)

    expect(await snapshot(order.id, member.id)).toEqual(before)
    expect((await oracle(order.id)).state).toBe('PARTIALLY_PAID')
    expect((await db.split_bill.findByPk(pendingSplit.id)).status).toBe('pending')
  })

  test('P0-1C. remainder settlement of exactly 80,000 completes once and supersedes the pending split', async () => {
    const member = await makeMember(store.id)
    const { order, pendingSplit } = await makePartiallyPaid({ customerId: member.id })
    const before = await snapshot(order.id, member.id)
    expect(before.pointRows).toBe(0) // DR-16: QR placement awards nothing

    const res = await updateStatus(adminToken, {
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      amount: 80000
    })
    expect(res.status).toBe(200)

    const after = await snapshot(order.id, member.id)
    const newTxns = after.txns.filter(([id]) => !before.txns.some(([bid]) => bid === id))
    expect(newTxns).toEqual([[expect.any(Number), 80000, 'CASH']])

    const o = await oracle(order.id)
    expect(o).toMatchObject({ G, V: 0, P: G, C: G, R: 0, N: G, O: 0, state: 'PAID' })
    expect(o.order.paymentStatus).toBe('paid')

    // Pending split atomically retired (interim representation: soft
    // delete + SUPERSEDED audit; explicit status needs migration MC-1).
    const split = await db.split_bill.findByPk(pendingSplit.id, { paranoid: false })
    expect(split.deletedAt).not.toBeNull()
    expect(split.status).toBe('pending')
    const audits = await auditFor('split_bill', pendingSplit.id)
    expect(audits.some((a) => a.newValues?.status === 'SUPERSEDED')).toBe(true)

    // Exactly-once side effects.
    expect(before.stock - after.stock).toBe(QTY)
    expect(await db.accounting_outbox.count({ where: { referenceType: 'order', referenceId: order.id, jobType: 'order_journal' } })).toBe(1)
    expect(after.pointRows).toBe(before.pointRows + 1) // completing settlement awards exactly once
  })
})

// ---------------------------------------------------------------------------
describe('P0-2 — no duplicate collection through a pending split', () => {
  test('P0-2A. full settlement supersedes the pending split; paying it is refused with no second effect', async () => {
    const member = await makeMember(store.id)
    const order = await makeQrOrder({ customerId: member.id })
    const splitRes = await createSplits(order.id, [G])
    expect(splitRes.status).toBe(201)
    const [split] = splitRes.body.data

    const settle = await updateStatus(adminToken, { id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash' })
    expect(settle.status).toBe(200)
    const retired = await db.split_bill.findByPk(split.id, { paranoid: false })
    expect(retired.deletedAt).not.toBeNull()
    expect((await auditFor('split_bill', split.id)).some((a) => a.newValues?.status === 'SUPERSEDED')).toBe(true)

    const before = await snapshot(order.id, member.id)
    const pay = await paySplit(split.id)
    expect(pay.status).toBe(409)
    expect(pay.body.code).toBe('SPLIT_NOT_PAYABLE')
    expect(await snapshot(order.id, member.id)).toEqual(before)

    const o = await oracle(order.id)
    expect(o).toMatchObject({ C: G, O: 0, state: 'PAID' })
    expect(await db.accounting_outbox.count({ where: { referenceType: 'order', referenceId: order.id, jobType: 'order_journal' } })).toBe(1)
  })

  test('P0-2B. a stray pending split on a PAID order is not payable', async () => {
    const order = await makeQrOrder()
    expect((await updateStatus(adminToken, { id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash' })).status).toBe(200)
    const stray = await db.split_bill.create({ order: order.id, splitNumber: unique('STRAY'), amount: G, status: 'pending' })
    const before = await snapshot(order.id)

    const pay = await paySplit(stray.id)
    expect(pay.status).toBe(409)
    expect(pay.body.code).toBe('SPLIT_NOT_PAYABLE')
    expect(await snapshot(order.id)).toEqual(before)
    expect((await oracle(order.id)).C).toBe(G)
  })

  test('P0-2C. cancel (nothing collected) retires pending splits; no split is payable on a cancelled order', async () => {
    const order = await makeQrOrder()
    const [split] = (await createSplits(order.id, [G])).body.data

    const cancel = await updateStatus(adminToken, { id: order.id, store: store.id, status: 'cancelled' })
    expect(cancel.status).toBe(200)
    const retired = await db.split_bill.findByPk(split.id, { paranoid: false })
    expect(retired.deletedAt).not.toBeNull()
    expect((await auditFor('split_bill', split.id)).some((a) => a.newValues?.status === 'CANCELLED')).toBe(true)

    const stray = await db.split_bill.create({ order: order.id, splitNumber: unique('STRAY'), amount: G, status: 'pending' })
    for (const id of [split.id, stray.id]) {
      const before = await snapshot(order.id)
      const pay = await paySplit(id)
      expect(pay.status).toBe(409)
      expect(pay.body.code).toBe('SPLIT_NOT_PAYABLE')
      expect(await snapshot(order.id)).toEqual(before)
    }
    expect((await oracle(order.id))).toMatchObject({ C: 0, R: 0 })
  })

  test('P0-2D. no split is payable on a voided (partially paid → REFUNDED) order', async () => {
    const { order, pendingSplit } = await makePartiallyPaid()
    const voidRes = await updateStatus(adminToken, { id: order.id, store: store.id, status: 'void', reason: 'P0-2D void' })
    expect(voidRes.status).toBe(200)

    const stray = await db.split_bill.create({ order: order.id, splitNumber: unique('STRAY'), amount: 80000, status: 'pending' })
    for (const id of [pendingSplit.id, stray.id]) {
      const before = await snapshot(order.id)
      const pay = await paySplit(id)
      expect(pay.status).toBe(409)
      expect(pay.body.code).toBe('SPLIT_NOT_PAYABLE')
      expect(await snapshot(order.id)).toEqual(before)
    }
    expect(await oracle(order.id)).toMatchObject({ C: 20000, R: 20000, state: 'REFUNDED' })
  })

  test('P0-2E. no split is payable on a fully settled then voided (REFUNDED) order', async () => {
    const order = await makeQrOrder()
    expect((await updateStatus(adminToken, { id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash' })).status).toBe(200)
    expect((await updateStatus(adminToken, { id: order.id, store: store.id, status: 'void', reason: 'P0-2E void' })).status).toBe(200)
    expect((await oracle(order.id)).state).toBe('REFUNDED')

    const stray = await db.split_bill.create({ order: order.id, splitNumber: unique('STRAY'), amount: G, status: 'pending' })
    const before = await snapshot(order.id)
    const pay = await paySplit(stray.id)
    expect(pay.status).toBe(409)
    expect(pay.body.code).toBe('SPLIT_NOT_PAYABLE')
    expect(await snapshot(order.id)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
describe('P0-3 — money never disappears on cancel; void refunds exactly what was collected', () => {
  test('P0-3A. cancel with net collected 20,000 is refused with CANCEL_REQUIRES_VOID and zero mutation', async () => {
    const member = await makeMember(store.id)
    const { order, pendingSplit } = await makePartiallyPaid({ customerId: member.id })
    const before = await snapshot(order.id, member.id)

    const res = await updateStatus(adminToken, { id: order.id, store: store.id, status: 'cancelled', reason: 'customer left' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CANCEL_REQUIRES_VOID')

    expect(await snapshot(order.id, member.id)).toEqual(before)
    expect(await oracle(order.id)).toMatchObject({ C: 20000, R: 0, O: 80000, state: 'PARTIALLY_PAID' })
    expect((await db.split_bill.findByPk(pendingSplit.id)).status).toBe('pending')
  })

  test('P0-3B. a cashier (kasir) cannot void: 403 and zero financial side effect', async () => {
    const member = await makeMember(store.id)
    const { order } = await makePartiallyPaid({ customerId: member.id })
    const before = await snapshot(order.id, member.id)

    const res = await updateStatus(kasirToken, { id: order.id, store: store.id, status: 'void', reason: 'kasir tries' })
    expect(res.status).toBe(403)
    expect(await snapshot(order.id, member.id)).toEqual(before)
  })

  test('P0-3C. authorized void refunds exactly C = 20,000 (V = G, R = C) to the refunding register and actor', async () => {
    const { order, pendingSplit } = await makePartiallyPaid()
    const stockBefore = await stockNow()

    const res = await updateStatus(adminToken, { id: order.id, store: store.id, status: 'void', reason: 'P0-3C customer dispute' })
    expect(res.status).toBe(200)

    const o = await oracle(order.id)
    // V (commercial value reversed) and R (money refunded) are distinct.
    expect(o).toMatchObject({ G, V: G, P: 0, C: 20000, R: 20000, N: 0, O: 0, state: 'REFUNDED' })
    expect(o.order.status).toBe('void')
    expect(o.order.paymentStatus).toBe('refunded')

    const refunds = o.rows.filter((r) => Number(r.amount) < 0)
    expect(refunds).toHaveLength(1)
    expect(Number(refunds[0].amount)).toBe(-20000)
    expect(refunds[0].typePayment).toBe('CASH') // default = original tender
    expect(refunds[0].createdBy).toBe(adminUser.id) // executing actor, server-resolved
    // Attributed to the register open at refund time (the collection
    // happened inside this same register window, so the order-level
    // attribution is truthful for both rows).
    expect(o.order.cashRegisterId).toBe(registerId)

    const split = await db.split_bill.findByPk(pendingSplit.id, { paranoid: false })
    expect(split.deletedAt).not.toBeNull()
    expect((await auditFor('split_bill', pendingSplit.id)).some((a) => a.newValues?.status === 'VOIDED')).toBe(true)
    // Never reached PAID → no stock was deducted → nothing to restore.
    expect(await stockNow()).toBe(stockBefore)
  })

  test('P0-3D. void with a cash portion and no open register → 422 REGISTER_REQUIRED, zero mutation', async () => {
    // P1 (DR-PAY-ATTR-02): split settlement itself now requires an open
    // register, so the partially-paid fixture is built while one is open
    // and the register is closed before the void — the void refusal (no
    // open register at refund time) and zero-mutation assertions stand.
    const opened = await request(app)
      .post('/cash-register/open')
      .set(auth(adminNoRegToken))
      .send({ store: storeNoRegister.id, openingBalance: 0, shift: 1 })
    expect([200, 201]).toContain(opened.status)
    const { order } = await makePartiallyPaid({ storeId: storeNoRegister.id })
    const closed = await request(app)
      .put(`/cash-register/close/${opened.body.data.id}`)
      .set(auth(adminNoRegToken))
      .send({ store: storeNoRegister.id, closingBalance: 20000 })
    expect(closed.status).toBe(200)
    const before = await snapshot(order.id)

    const res = await updateStatus(adminNoRegToken, {
      id: order.id,
      store: storeNoRegister.id,
      status: 'void',
      reason: 'P0-3D no register'
    })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('REGISTER_REQUIRED')
    expect(await snapshot(order.id)).toEqual(before)
  })

  test('P0-3E. void after the sale register closed attributes the cash refund to the refunding register, never the closed one', async () => {
    const openA = await request(app).post('/cash-register/open').set(auth(adminRotToken))
      .send({ store: storeRotating.id, openingBalance: 0, shift: 1 })
    expect([200, 201]).toContain(openA.status)
    const order = await makeQrOrder({ storeId: storeRotating.id })
    expect((await updateStatus(adminRotToken, { id: order.id, store: storeRotating.id, status: 'paid', paymentMethod: 'cash' })).status).toBe(200)
    expect((await db.order.findByPk(order.id)).cashRegisterId).toBe(openA.body.data.id)

    const close = await request(app).put(`/cash-register/close/${openA.body.data.id}`).set(auth(adminRotToken))
      .send({ store: storeRotating.id, closingBalance: G })
    expect(close.status).toBe(200)
    const openB = await request(app).post('/cash-register/open').set(auth(adminRotToken))
      .send({ store: storeRotating.id, openingBalance: 0, shift: 2 })
    expect([200, 201]).toContain(openB.status)

    const res = await updateStatus(adminRotToken, { id: order.id, store: storeRotating.id, status: 'void', reason: 'P0-3E' })
    // P1 (DR-PAY-ATTR-02/§21) supersedes the interim MC-4 refusal: every
    // settlement row already carries its own register, so the refund can
    // be attributed to the refunding register B without moving anything
    // out of closed A. The core guarantee stands — no refund row may ever
    // point at the closed sale register.
    expect(res.status).toBe(200)
    const o = await oracle(order.id)
    expect(o).toMatchObject({ V: G, P: 0, C: G, R: G, N: 0, O: 0, state: 'REFUNDED' })
    expect(o.order.status).toBe('void')
    const refunds = o.rows.filter((r) => Number(r.amount) < 0)
    expect(refunds).toHaveLength(1)
    expect(Number(refunds[0].cashRegisterId)).toBe(openB.body.data.id)
    const sales = o.rows.filter((r) => Number(r.amount) > 0)
    expect(sales).toHaveLength(1)
    expect(Number(sales[0].cashRegisterId)).toBe(openA.body.data.id)
  })
})

// ---------------------------------------------------------------------------
describe('P0-3 equivalent path — store deletion never cancels orders that hold money', () => {
  test('P0-3F. deleting a location whose orders hold net-collected money is refused; orders and money untouched', async () => {
    const doomed = await db.location.create({ name: unique('P0_DOOMED'), status: 'active' })
    const superAdmin = await db.user.create({
      userName: unique('p0_super'),
      email: `${unique('p0_super')}@test.com`,
      roleType: 'super_admin',
      userType: 'super_admin',
      store: doomed.id,
      status: 'active'
    })
    const superToken = await signSessionToken(
      { id: superAdmin.id, userName: superAdmin.userName, roleType: 'super_admin', store: doomed.id },
      JWT_SECRET
    )
    const paid = await db.order.create({
      orderNumber: unique('P0-DOOMED'),
      store: doomed.id,
      status: 'paid',
      paymentStatus: 'paid',
      subTotal: G,
      totalPrice: G,
      totalQuantity: 1,
      source: 'pos'
    })
    await db.transaction.create({ order: paid.id, typePayment: 'cash', amount: G })
    try {
      const res = await request(app)
        .delete('/location/delete-location')
        .set(auth(superToken))
        .send({ id: `loc-${doomed.id}` })
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('STORE_HAS_COLLECTED_ORDERS')

      const stillPaid = await db.order.findByPk(paid.id)
      expect(stillPaid.status).toBe('paid')
      expect(Number(stillPaid.store)).toBe(doomed.id)
      expect(await db.location.findByPk(doomed.id)).not.toBeNull()
      expect(await db.transaction.sum('amount', { where: { order: paid.id } })).toBe(G)
    } finally {
      await db.transaction.destroy({ where: { order: paid.id }, force: true })
      await db.order.destroy({ where: { id: paid.id }, force: true })
      await db.user.destroy({ where: { id: superAdmin.id }, force: true })
      await db.location.destroy({ where: { id: doomed.id }, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
describe('P0 legacy guard — a cached "paid" the ledger cannot explain is never re-opened', () => {
  test('P0-L1. legacy paid-without-ledger order: no split, no settlement, no automatic cancel/void', async () => {
    const order = await makeQrOrder()
    // Legacy shape (pre-F-PAY-1): marked paid with zero settlement rows.
    await db.order.update({ status: 'paid', paymentStatus: 'paid' }, { where: { id: order.id } })
    const before = await snapshot(order.id)

    const split = await createSplits(order.id, [G])
    expect(split.status).toBe(409)
    const settle = await updateStatus(adminToken, { id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash' })
    expect(settle.status).toBe(409)
    expect(settle.body.code).toBe('ORDER_NOT_SETTLEABLE')
    const cancel = await updateStatus(adminToken, { id: order.id, store: store.id, status: 'cancelled' })
    expect(cancel.status).toBe(409)
    expect(cancel.body.code).toBe('ORDER_UNRECONCILED')
    const voided = await updateStatus(adminToken, { id: order.id, store: store.id, status: 'void', reason: 'L1' })
    expect(voided.status).toBe(409)
    expect(voided.body.code).toBe('ORDER_UNRECONCILED')

    expect(await snapshot(order.id)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
describe('P0 concurrency — collected value never exceeds payable', () => {
  test('P0-C1. settlement vs settlement on outstanding 100,000: exactly one 100,000 effect', async () => {
    const order = await makeQrOrder()
    const body = { id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash' }
    const results = await Promise.all([updateStatus(adminToken, body), updateStatus(adminToken, body)])
    const codes = results.map((r) => r.status).sort()
    expect(codes).toEqual([200, 409])
    expect(results.find((r) => r.status === 409).body.code).toBe('OUTSTANDING_CHANGED')
    expect(await oracle(order.id)).toMatchObject({ C: G, O: 0, state: 'PAID' })
  })

  test('P0-C2. full settlement vs split payment: only one consumes the outstanding', async () => {
    const order = await makeQrOrder()
    const [split] = (await createSplits(order.id, [G])).body.data
    const [settle, pay] = await Promise.all([
      updateStatus(adminToken, { id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash' }),
      paySplit(split.id)
    ])
    expect([settle.status, pay.status].sort()).toEqual([200, 409])
    expect(await oracle(order.id)).toMatchObject({ C: G, O: 0, state: 'PAID' })
  })

  test('P0-C3. split vs split competing for the same outstanding: aggregate ≤ payable', async () => {
    const order = await makeQrOrder()
    // Legacy-shaped data: two pending splits that each claim the full total.
    const a = await db.split_bill.create({ order: order.id, splitNumber: unique('RACE_A'), amount: G, status: 'pending' })
    const b = await db.split_bill.create({ order: order.id, splitNumber: unique('RACE_B'), amount: G, status: 'pending' })
    const [ra, rb] = await Promise.all([paySplit(a.id), paySplit(b.id)])
    expect([ra.status, rb.status].sort()).toEqual([200, 409])
    expect(await oracle(order.id)).toMatchObject({ C: G, O: 0, state: 'PAID' })
  })

  test('P0-C4. cancel vs partial payment: never a cancelled order holding money', async () => {
    const order = await makeQrOrder()
    const [small] = (await createSplits(order.id, [20000, 80000])).body.data
    const [cancel, pay] = await Promise.all([
      updateStatus(adminToken, { id: order.id, store: store.id, status: 'cancelled' }),
      paySplit(small.id)
    ])
    const o = await oracle(order.id)
    if (cancel.status === 200) {
      expect(pay.status).toBe(409)
      expect(o.order.status).toBe('cancelled')
      expect(o).toMatchObject({ C: 0, R: 0, N: 0 })
    } else {
      expect(cancel.status).toBe(409)
      expect(cancel.body.code).toBe('CANCEL_REQUIRES_VOID')
      expect(pay.status).toBe(200)
      expect(o.order.status).not.toBe('cancelled')
      expect(o).toMatchObject({ C: 20000, O: 80000, state: 'PARTIALLY_PAID' })
    }
    expect(o.state).not.toBe('INVALID')
  })

  test('P0-C5. a duplicate settlement submission never produces a second financial effect', async () => {
    const order = await makeQrOrder()
    const body = { id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash' }
    expect((await updateStatus(adminToken, body)).status).toBe(200)
    const before = await snapshot(order.id)
    const replay = await updateStatus(adminToken, body)
    expect(replay.status).toBe(409)
    expect(replay.body.code).toBe('OUTSTANDING_CHANGED')
    expect(await snapshot(order.id)).toEqual(before)
  })
})
