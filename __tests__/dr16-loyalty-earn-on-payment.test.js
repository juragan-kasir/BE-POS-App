process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// DR-16 (KF-NEW-04/KF-NEW-26): loyalty points are earned only after
// successful payment. QR orders are created unpaid, so placement must award
// nothing; the award lands at settlement. Cancel/void/refund reverses earned
// points (partial refunds proportionally, under the same product.point x
// quantity formula). Redemption restoration on void is pre-existing behavior
// and must stay intact.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const PRICE = 50000
const POINT = 10

let store = null
let category = null
let product = null
let adminToken = null
let returnCounter = 0
const createdTableIds = []
const createdMemberIds = []
const createdOrderIds = []
const createdReturnIds = []

async function makeTable() {
  const t = await db.table.create({ store: store.id, name: unique('DR16_TABLE') })
  createdTableIds.push(t.id)
  return t
}

async function makeMember(totalPoints = 0) {
  const m = await db.member.create({
    name: unique('DR16_MEMBER'),
    phoneNumber: `08${Math.floor(1e9 + Math.random() * 9e9)}`,
    store: store.id,
    totalPoints,
    lifetimePoints: totalPoints,
    status: 'active'
  })
  createdMemberIds.push(m.id)
  return m
}

async function makeQrOrder({ member, qty = 2 } = {}) {
  const table = await makeTable()
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      ...(member ? { customerId: member.id } : {}),
      customerName: member ? undefined : unique('DR16 Guest'),
      items: [{ productId: product.id, productName: product.nameProduct, quantity: qty }],
      idempotencyKey: unique('dr16qr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  createdOrderIds.push(res.body.data.id)
  return res.body.data
}

async function settleCash(order, amount) {
  return request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      ...(amount !== undefined ? { amount } : {}),
      cashAmount: amount !== undefined ? amount : order.totalPrice,
      changeAmount: 0
    })
}

async function voidOrder(order, reason = 'DR16 test void') {
  return request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ id: order.id, store: store.id, status: 'void', reason })
}

async function cancelOrder(order) {
  return request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ id: order.id, store: store.id, status: 'cancelled' })
}

async function makeReturn({ order, qty, refundAmount }) {
  returnCounter += 1
  const ret = await db.sales_return.create({
    order: order.id,
    store: store.id,
    returnNumber: `DR16-SR-${Date.now()}-${returnCounter}`,
    status: 'pending',
    reason: 'DR16 test return',
    refundAmount,
    refundMethod: 'cash'
  })
  await db.sales_return_item.create({
    salesReturn: ret.id,
    product: product.id,
    qty,
    unit: 'pcs'
  })
  createdReturnIds.push(ret.id)
  return ret
}

async function approveReturn(ret) {
  return request(app)
    .patch(`/sales-return/approve/${ret.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ id: ret.id })
}

async function memberPoints(memberId) {
  return Number((await db.member.findByPk(memberId)).totalPoints)
}

async function earnedRows(memberId, orderId) {
  // member_point_history.transactionId is VARCHAR: compare as text.
  return db.member_point_history.findAll({
    where: { member: memberId, transactionId: String(orderId) },
    order: [['id', 'ASC']]
  })
}

async function earnedTotal(memberId, orderId) {
  const rows = await earnedRows(memberId, orderId)
  const earned = rows
    .filter((r) => String(r.notes || '').startsWith('Earned '))
    .reduce((s, r) => s + Number(r.pointsChange), 0)
  const reversed = rows
    .filter((r) => String(r.notes || '').startsWith('Reversed '))
    .reduce((s, r) => s + Math.abs(Number(r.pointsChange)), 0)
  return { earned, reversed, rows: rows.length }
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('DR16_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('DR16_CAT') })
  product = await db.product.create({
    nameProduct: unique('DR16_PRODUCT'),
    category: category.id,
    price: PRICE,
    point: POINT,
    stock: 1000
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.taxConfig.create({
    store: store.id,
    name: `DR16_PPN_${Date.now()}`,
    rate: 0,
    type: 'ppn',
    status: 'active'
  })
  const adminUser = await db.user.create({
    userName: unique('admin_dr16'),
    email: `${unique('admin_dr16')}@test.com`,
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
  if (![200, 201].includes(openRes.status)) {
    throw new Error('register setup failed: ' + JSON.stringify(openRes.body))
  }
  await db.user.create({
    id: 70016,
    userName: unique('dr16_admin_row'),
    email: `${unique('dr16_admin_row')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
})

afterAll(async () => {
  const stores = [store?.id].filter(Boolean)
  const orderIds = (
    await db.order.findAll({ where: { store: stores }, attributes: ['id'] })
  ).map((o) => o.id)
  await db.split_bill.destroy({ where: { order: orderIds }, force: true })
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.sales_return_item.destroy({ where: {}, force: true })
  await db.sales_return.destroy({ where: { store: stores }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.stock_history.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.member_point_history.destroy({ where: { member: createdMemberIds }, force: true })
  await db.member.destroy({ where: { id: createdMemberIds }, force: true })
  await db.table.destroy({ where: { id: createdTableIds }, force: true })
  await db.cashRegister.destroy({ where: { store: stores }, force: true })
  await db.taxConfig.destroy({ where: { store: stores }, force: true })
  await db.product_store_stock.destroy({ where: { store: stores }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: 70016 }, force: true })
  await db.user.destroy({ where: { store: stores }, force: true })
  await db.location.destroy({ where: { id: stores }, force: true })
})

describe('DR-16 QR earn timing', () => {
  test('QR placement awards zero earned points', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 2 })
    expect(await memberPoints(member.id)).toBe(0)
    const t = await earnedTotal(member.id, order.id)
    expect(t.earned).toBe(0)
    expect(t.rows).toBe(0)
  })

  test('cash settlement awards the formula amount', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 2 })
    const before = await earnedTotal(member.id, order.id)
    expect(before.earned).toBe(0)
    const res = await settleCash(order)
    expect(res.status).toBe(200)
    // POINT(10) x qty(2) = 20, awarded by the settlement itself.
    expect(await memberPoints(member.id)).toBe(20)
    const after = await earnedTotal(member.id, order.id)
    expect(after.earned).toBe(20)
    expect(after.reversed).toBe(0)
  })

  test('failed settlement awards nothing', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 2 })
    const res = await settleCash(order, 1)
    expect(res.status).toBe(409)
    expect(await memberPoints(member.id)).toBe(0)
    expect((await earnedTotal(member.id, order.id)).rows).toBe(0)
  })

  test('repeated settlement produces only one award', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 2 })
    const first = await settleCash(order)
    expect(first.status).toBe(200)
    const retry = await settleCash(order)
    expect(retry.status).toBe(409)
    expect(await memberPoints(member.id)).toBe(20)
    const t = await earnedTotal(member.id, order.id)
    expect(t.earned).toBe(20)
    expect(t.rows).toBe(1)
  })

  test('split-completed order earns exactly once at completion', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 2 })
    const total = Number(order.totalPrice)
    const splitRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 20000 }, { amount: total - 20000 }] })
    expect(splitRes.status).toBe(201)
    const [first, second] = splitRes.body.data
    const pay1 = await request(app)
      .put(`/split-bill/pay/${first.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'cash' })
    expect(pay1.status).toBe(200)
    expect(pay1.body.data.orderComplete).toBe(false)
    // Partial collection is not a successful payment: no award yet.
    expect((await earnedTotal(member.id, order.id)).earned).toBe(0)
    const pay2 = await request(app)
      .put(`/split-bill/pay/${second.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'cash' })
    expect(pay2.status).toBe(200)
    expect(pay2.body.data.orderComplete).toBe(true)
    expect(await memberPoints(member.id)).toBe(20)
    const t = await earnedTotal(member.id, order.id)
    expect(t.earned).toBe(20)
    expect(t.rows).toBe(1)
  })
})

describe('DR-16 earned-points reversal', () => {
  test('cancel before earning creates no reversal', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 2 })
    const res = await cancelOrder(order)
    expect(res.status).toBe(200)
    expect(await memberPoints(member.id)).toBe(0)
    expect((await earnedTotal(member.id, order.id)).rows).toBe(0)
  })

  test('void after earning reverses the full award', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 2 })
    expect((await settleCash(order)).status).toBe(200)
    expect(await memberPoints(member.id)).toBe(20)
    const res = await voidOrder(order)
    expect(res.status).toBe(200)
    expect(await memberPoints(member.id)).toBe(0)
    const t = await earnedTotal(member.id, order.id)
    expect(t.earned).toBe(20)
    expect(t.reversed).toBe(20)
  })

  test('repeat void does not reverse twice', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 2 })
    expect((await settleCash(order)).status).toBe(200)
    expect((await voidOrder(order)).status).toBe(200)
    // Same-terminal repeat is a no-op success (not a second refund).
    const retry = await voidOrder(order)
    expect(retry.status).toBe(200)
    const t = await earnedTotal(member.id, order.id)
    expect(t.earned).toBe(20)
    expect(t.reversed).toBe(20)
    expect(await memberPoints(member.id)).toBe(0)
  })

  test('full-quantity return reverses the full award', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 2 })
    expect((await settleCash(order)).status).toBe(200)
    const ret = await makeReturn({ order, qty: 2, refundAmount: order.totalPrice })
    const res = await approveReturn(ret)
    expect(res.status).toBe(200)
    expect(await memberPoints(member.id)).toBe(0)
    const t = await earnedTotal(member.id, order.id)
    expect(t.earned).toBe(20)
    expect(t.reversed).toBe(20)
  })

  test('partial return reverses the proportional formula amount', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 4 })
    expect((await settleCash(order)).status).toBe(200)
    // Earn: 10 x 4 = 40. Return 1 unit (50000) -> reverse 10 x 1 = 10.
    const ret = await makeReturn({ order, qty: 1, refundAmount: PRICE })
    expect((await approveReturn(ret)).status).toBe(200)
    expect(await memberPoints(member.id)).toBe(30)
    const t = await earnedTotal(member.id, order.id)
    expect(t.earned).toBe(40)
    expect(t.reversed).toBe(10)
  })

  test('multiple partial returns never double-reverse', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 4 })
    expect((await settleCash(order)).status).toBe(200)
    const ret1 = await makeReturn({ order, qty: 1, refundAmount: PRICE })
    expect((await approveReturn(ret1)).status).toBe(200)
    const ret2 = await makeReturn({ order, qty: 1, refundAmount: PRICE })
    expect((await approveReturn(ret2)).status).toBe(200)
    expect(await memberPoints(member.id)).toBe(20)
    const t = await earnedTotal(member.id, order.id)
    expect(t.earned).toBe(40)
    expect(t.reversed).toBe(20)
  })

  test('partial returns then remaining return reverse exactly the award', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 4 })
    expect((await settleCash(order)).status).toBe(200)
    const ret1 = await makeReturn({ order, qty: 1, refundAmount: PRICE })
    expect((await approveReturn(ret1)).status).toBe(200)
    const ret2 = await makeReturn({ order, qty: 3, refundAmount: PRICE * 3 })
    expect((await approveReturn(ret2)).status).toBe(200)
    // Capped at the original award: 10 + 30 = 40, never more.
    expect(await memberPoints(member.id)).toBe(0)
    const t = await earnedTotal(member.id, order.id)
    expect(t.earned).toBe(40)
    expect(t.reversed).toBe(40)
  })

  test('duplicate approve reverses only once', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 2 })
    expect((await settleCash(order)).status).toBe(200)
    const ret = await makeReturn({ order, qty: 2, refundAmount: order.totalPrice })
    expect((await approveReturn(ret)).status).toBe(200)
    const retry = await approveReturn(ret)
    expect(retry.status).toBe(409)
    const t = await earnedTotal(member.id, order.id)
    expect(t.earned).toBe(20)
    expect(t.reversed).toBe(20)
    expect(await memberPoints(member.id)).toBe(0)
  })
})

describe('DR-16 preserved behavior', () => {
  test('counter order earning is unchanged and single', async () => {
    const member = await makeMember(0)
    const createRes = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        customerId: member.id,
        items: [{ product: product.id, quantity: 2 }],
        paymentMethod: 'cash',
        cashAmount: PRICE * 2,
        changeAmount: 0,
        cashierName: 'DR16',
        idempotencyKey: unique('dr16counter')
      })
    expect(createRes.status).toBe(201)
    const orderId = createRes.body.data.id
    createdOrderIds.push(orderId)
    expect(await memberPoints(member.id)).toBe(20)
    const t = await earnedTotal(member.id, orderId)
    expect(t.earned).toBe(20)
    expect(t.rows).toBe(1)
    // Already fully paid: a further settlement is refused, no second award.
    const retry = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: orderId, store: store.id, status: 'paid', paymentMethod: 'cash' })
    expect(retry.status).toBe(409)
    expect(await memberPoints(member.id)).toBe(20)
  })

  test('redemption restoration on void is unchanged', async () => {
    const member = await makeMember(PRICE * 2)
    const order = await makeQrOrder({ member, qty: 2 })
    // Settle entirely with points: redeems 100000 and earns 20.
    const res = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'points' })
    expect(res.status).toBe(200)
    expect(await memberPoints(member.id)).toBe(20)
    expect((await voidOrder(order)).status).toBe(200)
    // Redemption restored (100000) and earned award reversed (20).
    expect(await memberPoints(member.id)).toBe(PRICE * 2)
  })
})

describe('DR-16 free-text name grants nothing', () => {
  async function makeTieredMember() {
    const tier = await db.member_tier.create({
      name: unique('DR16_TIER'),
      discountPercent: 15,
      status: 'active'
    })
    const member = await db.member.create({
      name: unique('DR16 Named Member'),
      phoneNumber: `08${Math.floor(1e9 + Math.random() * 9e9)}`,
      store: store.id,
      totalPoints: 0,
      lifetimePoints: 0,
      status: 'active',
      tier: tier.id
    })
    createdMemberIds.push(member.id)
    return member
  }

  async function makeQrOrderAsName(name, qty = 2) {
    const table = await makeTable()
    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store.id,
        tableId: table.id,
        customerName: name,
        items: [{ productId: product.id, productName: product.nameProduct, quantity: qty }],
        idempotencyKey: unique('dr16qrname')
      })
    if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
    createdOrderIds.push(res.body.data.id)
    return res.body.data
  }

  test('exact member name attaches no identity and no discount', async () => {
    const member = await makeTieredMember()
    const order = await makeQrOrderAsName(member.name, 2)
    const row = await db.order.findByPk(order.id)
    // Free text stays a label only: no member link, no tier discount.
    expect(row.customerId).toBeNull()
    expect(row.customerName).toBe(member.name)
    expect(Number(row.discountAmount) || 0).toBe(0)
    // Settlement cannot earn for an unattached member.
    expect((await settleCash(row)).status).toBe(200)
    expect(await memberPoints(member.id)).toBe(0)
    expect((await earnedTotal(member.id, order.id)).rows).toBe(0)
  })

  test('case-variant member name attaches nothing', async () => {
    const member = await makeTieredMember()
    const order = await makeQrOrderAsName(member.name.toUpperCase(), 2)
    const row = await db.order.findByPk(order.id)
    expect(row.customerId).toBeNull()
    expect(await memberPoints(member.id)).toBe(0)
  })

  test('explicit customerId attach still works (preservation)', async () => {
    const member = await makeMember(0)
    const order = await makeQrOrder({ member, qty: 2 })
    const row = await db.order.findByPk(order.id)
    expect(Number(row.customerId)).toBe(member.id)
    expect((await settleCash(row)).status).toBe(200)
    expect(await memberPoints(member.id)).toBe(20)
  })
})
