process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// DR-04 P2-1: PUT /order/update-status { status: 'paid', paymentMethod:
// 'points' } atomically redeems the order's full totalPrice (1 point = Rp1)
// from the member already attached to the order, together with the
// settlement itself. Non-contract fields (memberId, redeemedPoints) are
// stripped and ignored; amount is server-derived. customerId follows the
// DR-16 attachment contract: omitted/same member settles, a different member
// is rejected 409 MEMBER_MISMATCH with nothing persisted (never silently
// replaced). Business failures are 422 with nothing persisted; a replay never
// deducts twice; settlement awards nothing here because this file's product
// carries point: 0 (earn-on-settlement for point-bearing products is covered
// by the dr16-loyalty-earn-on-payment suite).

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let otherStore = null
let category = null
let product = null
let adminToken = null
let registerId = null
const createdTableIds = []
const createdMemberIds = []
const createdOrderIds = []

const PRICE = 50000

async function makeTable(storeId) {
  const t = await db.table.create({ store: storeId, name: unique('P21_TABLE') })
  createdTableIds.push(t.id)
  return t
}

async function makeMember({ storeId, totalPoints }) {
  const m = await db.member.create({
    name: unique('P21_MEMBER'),
    phoneNumber: `08${Math.floor(1e9 + Math.random() * 9e9)}`,
    store: storeId,
    totalPoints,
    lifetimePoints: totalPoints,
    status: 'active'
  })
  createdMemberIds.push(m.id)
  return m
}

async function makeQrOrder({ customerId } = {}) {
  // One open QR order per table: every QR order gets a fresh table.
  const table = await makeTable(store.id)
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      ...(customerId ? { customerId } : {}),
      customerName: customerId ? undefined : unique('P21 Guest'),
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
      idempotencyKey: unique('p21qr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  createdOrderIds.push(res.body.data.id)
  return res.body.data
}

async function settlePaid(body) {
  return request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(body)
}

async function txnRows(orderId) {
  return db.transaction.findAll({ where: { order: orderId } })
}

async function historyRows(memberId) {
  return db.member_point_history.findAll({ where: { member: memberId }, order: [['id', 'ASC']] })
}

async function memberPoints(memberId) {
  return Number((await db.member.findByPk(memberId)).totalPoints)
}

// Everything a failed points settlement must leave untouched.
async function snapshot(orderId, memberId) {
  const order = await db.order.findByPk(orderId)
  return {
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    cashRegisterId: order.cashRegisterId,
    txns: (await txnRows(orderId)).length,
    statusRows: await db.order_status.count({ where: { order: orderId } }),
    saleStockRows: await db.stock_history.count({
      where: { referenceType: 'sale', referenceId: orderId }
    }),
    points: memberId ? await memberPoints(memberId) : null,
    history: memberId ? (await historyRows(memberId)).length : null
  }
}

function expectBusinessFailure(res, pattern) {
  expect(res.status).toBe(422)
  expect(String(res.body.message || res.body.error || '')).toMatch(pattern)
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('P21_STORE'), status: 'active' })
  otherStore = await db.location.create({ name: unique('P21_OTHER'), status: 'active' })
  category = await db.category.create({ name: unique('P21_CAT') })
  // point: 0 — QR creation awards no earned points, so every balance
  // movement observed below is the settlement's own.
  product = await db.product.create({
    nameProduct: unique('P21_PRODUCT'),
    category: category.id,
    price: PRICE,
    point: 0,
    stock: 500
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 500 })
  // Explicit 0% PPN keeps the due exactly PRICE.
  await db.taxConfig.create({
    store: store.id,
    name: `P21_PPN_${store.id}`,
    rate: 0,
    type: 'ppn',
    status: 'active'
  })

  const adminUser = await db.user.create({
    userName: unique('admin_p21'),
    email: `${unique('admin_p21')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )

  const openRes = await request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: store.id, openingBalance: 100000, shift: 1 })
  if (openRes.status !== 201 && openRes.status !== 200) {
    throw new Error('register setup failed: ' + JSON.stringify(openRes.body))
  }
  registerId = openRes.body.data.id
})

afterAll(async () => {
  const stores = [store?.id, otherStore?.id].filter(Boolean)
  const orderIds = (
    await db.order.findAll({ where: { store: stores }, attributes: ['id'] })
  ).map((o) => o.id)
  // The split-paid test leaves a live paid split row; remove it before the
  // order so cleanup does not depend on the DB-level ON DELETE CASCADE.
  await db.split_bill.destroy({ where: { order: orderIds }, force: true })
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.member_point_history.destroy({ where: { member: createdMemberIds }, force: true })
  await db.member.destroy({ where: { id: createdMemberIds }, force: true })
  await db.cashMovement.destroy({ where: { store: stores }, force: true })
  await db.cashRegister.destroy({ where: { store: stores }, force: true })
  await db.best_selling.destroy({ where: { store: stores }, force: true })
  await db.product_store_stock.destroy({ where: { store: stores }, force: true })
  await db.stock_history.destroy({ where: { store: stores }, force: true })
  await db.taxConfig.destroy({ where: { store: stores }, force: true })
  await db.table.destroy({ where: { id: createdTableIds }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: stores }, force: true })
  await db.location.destroy({ where: { id: stores }, force: true })
})

describe('DR-04 P2-1 points settlement — success', () => {
  test('member order redeems exactly totalPrice atomically with the settlement', async () => {
    const member = await makeMember({ storeId: store.id, totalPoints: PRICE + 12345 })
    const order = await makeQrOrder({ customerId: member.id })
    expect(order.paymentStatus).toBe('unpaid')
    expect(Number(order.customerId)).toBe(member.id)
    const historyBefore = (await historyRows(member.id)).length

    const res = await settlePaid({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'points' })
    expect(res.status).toBe(200)

    // Order settled with register attribution.
    const settled = await db.order.findByPk(order.id)
    expect(settled.paymentStatus).toBe('paid')
    expect(settled.status).toBe('paid')
    expect(settled.paymentMethod).toBe('POINTS')
    expect(Number(settled.cashRegisterId)).toBe(Number(registerId))

    // Single payment row with the points tender and no cash detail.
    const rows = await txnRows(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].typePayment).toBe('POINTS')
    expect(Number(rows[0].amount)).toBe(PRICE)
    expect(rows[0].cashReceived).toBeNull()
    expect(Number(rows[0].changeGiven)).toBe(0)

    // Exact deduction, one negative history row referencing the order.
    expect(await memberPoints(member.id)).toBe(12345)
    const history = await historyRows(member.id)
    expect(history).toHaveLength(historyBefore + 1)
    const h = history[history.length - 1]
    expect(Number(h.pointsChange)).toBe(-PRICE)
    expect(Number(h.pointsBefore)).toBe(PRICE + 12345)
    expect(Number(h.pointsAfter)).toBe(12345)
    expect(String(h.transactionId)).toBe(String(order.id))

    // Stock deducted in the same unit; no earned points on settlement.
    expect(
      await db.stock_history.count({ where: { referenceType: 'sale', referenceId: order.id } })
    ).toBeGreaterThan(0)
    expect(history.filter((r) => Number(r.pointsChange) > 0)).toHaveLength(0)
    const lifetime = Number((await db.member.findByPk(member.id)).lifetimePoints)
    expect(lifetime).toBe(PRICE + 12345)
  })

  test('balance exactly equal to totalPrice settles to zero', async () => {
    const member = await makeMember({ storeId: store.id, totalPoints: PRICE })
    const order = await makeQrOrder({ customerId: member.id })

    const res = await settlePaid({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'points' })
    expect(res.status).toBe(200)
    expect(await memberPoints(member.id)).toBe(0)
    expect((await db.order.findByPk(order.id)).paymentStatus).toBe('paid')
  })

  test('client-supplied memberId/redeemedPoints are ignored', async () => {
    // memberId / redeemedPoints are not part of the update-status contract
    // (unknown keys are stripped): settlement uses the order's member.
    const orderMember = await makeMember({ storeId: store.id, totalPoints: PRICE * 2 })
    const decoy = await makeMember({ storeId: store.id, totalPoints: PRICE * 5 })
    const order = await makeQrOrder({ customerId: orderMember.id })

    const res = await settlePaid({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'points',
      memberId: decoy.id,
      redeemedPoints: 1
    })
    expect(res.status).toBe(200)
    expect(await memberPoints(orderMember.id)).toBe(PRICE)
    expect(await memberPoints(decoy.id)).toBe(PRICE * 5)
    expect(await historyRows(decoy.id)).toHaveLength(0)
  })

  test('client-supplied different customerId is rejected with 409 MEMBER_MISMATCH', async () => {
    // DR-16 fail-closed attachment: a different member is never silently
    // substituted; the settlement is refused with nothing persisted.
    const orderMember = await makeMember({ storeId: store.id, totalPoints: PRICE * 2 })
    const decoy = await makeMember({ storeId: store.id, totalPoints: PRICE * 5 })
    const order = await makeQrOrder({ customerId: orderMember.id })
    const before = await snapshot(order.id, orderMember.id)
    const beforeDecoyPoints = await memberPoints(decoy.id)

    const res = await settlePaid({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'points',
      customerId: decoy.id
    })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('MEMBER_MISMATCH')
    expect(await snapshot(order.id, orderMember.id)).toEqual(before)
    expect(await memberPoints(decoy.id)).toBe(beforeDecoyPoints)
    expect(await historyRows(decoy.id)).toHaveLength(0)
  })
})

describe('DR-04 P2-1 points settlement — business failures (422, nothing persisted)', () => {
  test('guest/no-member order cannot settle with points', async () => {
    const order = await makeQrOrder()
    expect(order.customerId == null).toBe(true)
    const before = await snapshot(order.id)

    const res = await settlePaid({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'points' })
    expectBusinessFailure(res, /^Order has no attached member; points settlement requires a member$/)
    expect(await snapshot(order.id)).toEqual(before)
    expect(before.paymentStatus).toBe('unpaid')
    expect(before.txns).toBe(0)
  })

  test('order referencing a missing member row fails', async () => {
    const member = await makeMember({ storeId: store.id, totalPoints: PRICE * 2 })
    const order = await makeQrOrder({ customerId: member.id })
    // order.customerId has no FK; simulate a member row that no longer exists.
    await db.order.update({ customerId: 2147480000 }, { where: { id: order.id } })
    const before = await snapshot(order.id, member.id)

    const res = await settlePaid({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'points' })
    expectBusinessFailure(res, /^Order has no attached member; points settlement requires a member$/)
    expect(await snapshot(order.id, member.id)).toEqual(before)
    expect(before.txns).toBe(0)
  })

  test('insufficient balance fails instead of clamping to zero', async () => {
    const member = await makeMember({ storeId: store.id, totalPoints: PRICE - 1 })
    const order = await makeQrOrder({ customerId: member.id })
    const before = await snapshot(order.id, member.id)

    const res = await settlePaid({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'points' })
    expectBusinessFailure(res, /^Insufficient point balance$/)
    const after = await snapshot(order.id, member.id)
    expect(after).toEqual(before)
    expect(after.points).toBe(PRICE - 1)
    expect(after.paymentStatus).toBe('unpaid')
  })

  test('member belonging to another store fails', async () => {
    const member = await makeMember({ storeId: store.id, totalPoints: PRICE * 2 })
    const order = await makeQrOrder({ customerId: member.id })
    await db.member.update({ store: otherStore.id }, { where: { id: member.id } })
    const before = await snapshot(order.id, member.id)

    const res = await settlePaid({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'points' })
    expectBusinessFailure(res, /^Member does not belong to this store$/)
    const after = await snapshot(order.id, member.id)
    expect(after).toEqual(before)
    expect(after.points).toBe(PRICE * 2)
  })
})

describe('DR-04 P2-1 points settlement — idempotency', () => {
  test('points request on an already-settled order is refused: no deduction, no history, no payment row', async () => {
    const member = await makeMember({ storeId: store.id, totalPoints: PRICE * 3 })
    const createRes = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(withIdempotencyKey({
        store: store.id,
        customerId: member.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashAmount: PRICE,
        changeAmount: 0,
        cashierName: 'P21',
        idempotencyKey: unique('p21create')
      }))
    expect(createRes.status).toBe(201)
    const orderId = createRes.body.data.id
    createdOrderIds.push(orderId)
    const pointsBefore = await memberPoints(member.id)
    const historyBefore = (await historyRows(member.id)).length

    // DR-23 (BA §35.10): outstanding is 0, so a further settlement is
    // refused on the fresh state — never a hidden 200 no-op.
    const res = await settlePaid({ id: orderId, store: store.id, status: 'paid', paymentMethod: 'points' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('OUTSTANDING_CHANGED')

    const rows = await txnRows(orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0].typePayment).toBe('CASH')
    expect(await memberPoints(member.id)).toBe(pointsBefore)
    expect(await historyRows(member.id)).toHaveLength(historyBefore)
  })

  test('partially split-paid order: a stale points settlement is refused; the exact remainder redeems exactly the outstanding', async () => {
    // DR-23 (BA §35.10 E, P0-1): a partial split payment makes the order
    // PARTIALLY_PAID. The former "skip because a settlement row exists"
    // behaviour (which marked the order paid with only 20,000 collected)
    // is superseded: settlement must equal the CURRENT outstanding amount.
    const member = await makeMember({ storeId: store.id, totalPoints: PRICE * 3 })
    const order = await makeQrOrder({ customerId: member.id })

    const splitRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 20000 }, { amount: PRICE - 20000 }] })
    expect(splitRes.status).toBe(201)
    const payRes = await request(app)
      .put(`/split-bill/pay/${splitRes.body.data[0].id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'cash' })
    expect(payRes.status).toBe(200)
    expect(payRes.body.data.orderComplete).toBe(false)

    const pre = await db.order.findByPk(order.id)
    expect(pre.status).toBe('pending')
    expect(pre.paymentStatus).toBe('partial') // PARTIALLY_PAID (legacy carrier)
    const pointsBefore = await memberPoints(member.id)
    expect(pointsBefore).toBe(PRICE * 3)
    const historyBefore = (await historyRows(member.id)).length

    // Stale claim of the full total (no amount) → refused, no points move.
    const stale = await settlePaid({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'points' })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('OUTSTANDING_CHANGED')
    expect(stale.body.outstanding).toBe(PRICE - 20000)
    expect(await memberPoints(member.id)).toBe(pointsBefore)
    expect(await historyRows(member.id)).toHaveLength(historyBefore)
    expect(await txnRows(order.id)).toHaveLength(1)
    expect((await db.order.findByPk(order.id)).paymentStatus).toBe('partial')

    // Exact remainder → points redeem exactly the outstanding amount.
    const remainder = await settlePaid({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'points',
      amount: PRICE - 20000
    })
    expect(remainder.status).toBe(200)
    expect(await memberPoints(member.id)).toBe(pointsBefore - (PRICE - 20000))
    const rows = await txnRows(order.id)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => [r.typePayment, Number(r.amount)]).sort()).toEqual(
      [['CASH', 20000], ['POINTS', PRICE - 20000]].sort()
    )
    const after = await db.order.findByPk(order.id)
    expect(after.paymentStatus).toBe('paid')
    expect(after.paymentMethod).toBe('POINTS')
  })

  test('repeated paid transition does not deduct again', async () => {
    const member = await makeMember({ storeId: store.id, totalPoints: PRICE * 3 })
    const order = await makeQrOrder({ customerId: member.id })

    const first = await settlePaid({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'points' })
    expect(first.status).toBe(200)
    expect(await memberPoints(member.id)).toBe(PRICE * 2)
    const historyAfterFirst = (await historyRows(member.id)).length

    const second = await settlePaid({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'points' })
    expect(second.status).toBe(409)
    expect(second.body.code).toBe('OUTSTANDING_CHANGED')
    expect(await memberPoints(member.id)).toBe(PRICE * 2)
    expect(await historyRows(member.id)).toHaveLength(historyAfterFirst)
    expect(await txnRows(order.id)).toHaveLength(1)
  })
})

describe('DR-04 P2-1 points settlement — concurrency', () => {
  test('two orders racing on a balance that covers one: exactly one settles', async () => {
    const member = await makeMember({ storeId: store.id, totalPoints: PRICE })
    const orderA = await makeQrOrder({ customerId: member.id })
    const orderB = await makeQrOrder({ customerId: member.id })
    const historyBefore = (await historyRows(member.id)).length

    // Genuinely concurrent requests against the in-process app — two real
    // Postgres transactions contending on the same member row lock.
    const [resA, resB] = await Promise.all([
      settlePaid({ id: orderA.id, store: store.id, status: 'paid', paymentMethod: 'points' }),
      settlePaid({ id: orderB.id, store: store.id, status: 'paid', paymentMethod: 'points' })
    ])

    const statuses = [resA.status, resB.status].sort()
    expect(statuses).toEqual([200, 422])
    const loser = resA.status === 422 ? resA : resB
    expect(String(loser.body.message || loser.body.error)).toBe('Insufficient point balance')

    expect(await memberPoints(member.id)).toBe(0)
    const history = await historyRows(member.id)
    expect(history).toHaveLength(historyBefore + 1)
    expect(Number(history[history.length - 1].pointsChange)).toBe(-PRICE)

    const paidTxns = [...(await txnRows(orderA.id)), ...(await txnRows(orderB.id))]
    expect(paidTxns).toHaveLength(1)
    expect(paidTxns[0].typePayment).toBe('POINTS')

    const [a, b] = await Promise.all([db.order.findByPk(orderA.id), db.order.findByPk(orderB.id)])
    expect([a.paymentStatus, b.paymentStatus].sort()).toEqual(['paid', 'unpaid'])
  })
})
