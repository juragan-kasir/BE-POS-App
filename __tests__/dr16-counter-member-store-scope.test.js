process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// DR-16 (scoped member identity) + DR-01 (no cross-boundary member scope):
// a member identity supplied on the counter paths — POST /order/create and
// staff attachment at settlement (PUT /order/update-status) — must resolve
// inside the order's store under the SAME rule counter points redemption
// already enforces (member.store is the order store, or the member is a
// store-less legacy member). A foreign or unknown member id must unlock no
// tier discount, receive no points, and never be persisted on the order.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const PRICE = 50000
const POINT = 10
const TIER_PERCENT = 10

let store = null
let otherStore = null
let category = null
let product = null
let tier = null
let foreignTier = null
let adminToken = null
const createdTableIds = []
const createdMemberIds = []

async function makeMember({ storeId, tierId = null }) {
  const m = await db.member.create({
    name: unique('SCOPE_MEMBER'),
    phoneNumber: `08${Math.floor(1e9 + Math.random() * 9e9)}`,
    store: storeId,
    tier: tierId,
    totalPoints: 0,
    lifetimePoints: 0,
    status: 'active'
  })
  createdMemberIds.push(m.id)
  return m
}

async function counterSale(body = {}) {
  return request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: store.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'Scope Cashier',
      idempotencyKey: unique('scope'),
      ...body
    })
}

async function makeAnonymousQrOrder() {
  const table = await db.table.create({ store: store.id, name: unique('SCOPE_TABLE') })
  createdTableIds.push(table.id)
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      customerName: unique('Scope Guest'),
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
      idempotencyKey: unique('scopeqr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function settleWithMember(order, customerId) {
  return request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      customerId,
      cashAmount: order.totalPrice,
      changeAmount: 0
    })
}

async function memberState(memberId) {
  const m = await db.member.findByPk(memberId)
  const history = await db.member_point_history.count({ where: { member: memberId } })
  return { totalPoints: Number(m.totalPoints), lifetimePoints: Number(m.lifetimePoints), history }
}

async function storeOrderCount() {
  return db.order.count({ where: { store: store.id } })
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('SCOPE_STORE'), status: 'active' })
  otherStore = await db.location.create({ name: unique('SCOPE_OTHER'), status: 'active' })
  category = await db.category.create({ name: unique('SCOPE_CAT') })
  product = await db.product.create({
    nameProduct: unique('SCOPE_PRODUCT'),
    category: category.id,
    price: PRICE,
    point: POINT,
    stock: 1000
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.taxConfig.create({
    store: store.id,
    name: `SCOPE_PPN_${Date.now()}`,
    rate: 0,
    type: 'ppn',
    status: 'active'
  })
  tier = await db.member_tier.create({
    store: store.id,
    name: unique('SCOPE_TIER'),
    minPoints: 0,
    maxPoints: 1000000,
    discountPercent: TIER_PERCENT,
    status: 'active'
  })
  foreignTier = await db.member_tier.create({
    store: otherStore.id,
    name: unique('SCOPE_FOREIGN_TIER'),
    minPoints: 0,
    maxPoints: 1000000,
    discountPercent: TIER_PERCENT,
    status: 'active'
  })
  const adminUser = await db.user.create({
    userName: unique('admin_scope'),
    email: `${unique('admin_scope')}@test.com`,
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
})

afterAll(async () => {
  const stores = [store?.id, otherStore?.id].filter(Boolean)
  const orderIds = (
    await db.order.findAll({ where: { store: stores }, attributes: ['id'] })
  ).map((o) => o.id)
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.stock_history.destroy({ where: { store: stores }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.member_point_history.destroy({ where: { member: createdMemberIds }, force: true })
  await db.member.destroy({ where: { id: createdMemberIds }, force: true })
  await db.member_tier.destroy({ where: { store: stores }, force: true })
  await db.table.destroy({ where: { id: createdTableIds }, force: true })
  await db.cashRegister.destroy({ where: { store: stores }, force: true })
  await db.taxConfig.destroy({ where: { store: stores }, force: true })
  await db.product_store_stock.destroy({ where: { store: stores }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: stores }, force: true })
  await db.location.destroy({ where: { id: stores }, force: true })
})

describe('DR-16 counter sale member scope (POST /order/create)', () => {
  test('foreign-store member is refused: no order, no tier discount, no points written', async () => {
    const foreign = await makeMember({ storeId: otherStore.id, tierId: foreignTier.id })
    const before = await memberState(foreign.id)
    const ordersBefore = await storeOrderCount()

    const res = await counterSale({ customerId: foreign.id, cashAmount: PRICE, changeAmount: 0 })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Member does not belong to this store')
    expect(await storeOrderCount()).toBe(ordersBefore)
    expect(await memberState(foreign.id)).toEqual(before)
  })

  test('unknown member id is refused instead of being persisted as a dangling customerId', async () => {
    const ordersBefore = await storeOrderCount()

    const res = await counterSale({ customerId: 2147480001 })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Member not found')
    expect(await storeOrderCount()).toBe(ordersBefore)
  })

  test('same-store member keeps its tier discount and earns points (preserved)', async () => {
    const member = await makeMember({ storeId: store.id, tierId: tier.id })
    const discounted = PRICE - (PRICE * TIER_PERCENT) / 100

    const res = await counterSale({ customerId: member.id, cashAmount: discounted, changeAmount: 0 })

    expect(res.status).toBe(201)
    expect(Number(res.body.data.customerId)).toBe(member.id)
    expect(Number(res.body.data.discountAmount)).toBe((PRICE * TIER_PERCENT) / 100)
    expect(Number(res.body.data.totalPrice)).toBe(discounted)
    expect((await memberState(member.id)).totalPoints).toBe(POINT)
  })

  test('store-less legacy member stays allowed, matching counter redemption (preserved)', async () => {
    const legacy = await makeMember({ storeId: null })

    const res = await counterSale({ customerId: legacy.id, cashAmount: PRICE, changeAmount: 0 })

    expect(res.status).toBe(201)
    expect(Number(res.body.data.customerId)).toBe(legacy.id)
  })
})

describe('DR-16 settlement attachment member scope (PUT /order/update-status)', () => {
  test('foreign-store member cannot be attached: order stays unpaid and unattached, no points', async () => {
    const foreign = await makeMember({ storeId: otherStore.id })
    const before = await memberState(foreign.id)
    const order = await makeAnonymousQrOrder()

    const res = await settleWithMember(order, foreign.id)

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('Member does not belong to this store')
    expect(res.body.code).toBe('MEMBER_OUT_OF_SCOPE')
    const after = await db.order.findByPk(order.id)
    expect(after.customerId).toBeNull()
    expect(after.paymentStatus).toBe('unpaid')
    expect(await memberState(foreign.id)).toEqual(before)
  })

  test('unknown member id cannot be attached', async () => {
    const order = await makeAnonymousQrOrder()

    const res = await settleWithMember(order, 2147480002)

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('Member not found')
    expect(res.body.code).toBe('MEMBER_NOT_FOUND')
    const after = await db.order.findByPk(order.id)
    expect(after.customerId).toBeNull()
    expect(after.paymentStatus).toBe('unpaid')
  })

  test('same-store member attaches and earns at settlement (preserved)', async () => {
    const member = await makeMember({ storeId: store.id })
    const order = await makeAnonymousQrOrder()

    const res = await settleWithMember(order, member.id)

    expect(res.status).toBe(200)
    const after = await db.order.findByPk(order.id)
    expect(Number(after.customerId)).toBe(member.id)
    expect(after.paymentStatus).toBe('paid')
    expect((await memberState(member.id)).totalPoints).toBe(POINT)
  })
})

// Review finding on #196: updateOrderStatus persists `customerId` on ANY
// status change when the order has no member yet. The scope check must
// guard every such attach, not only the paid branch — otherwise a foreign
// member attached by a fulfilment update is later awarded at settlement.
describe('DR-16 member scope on non-settlement status changes', () => {
  async function updateStatus(order, status, customerId) {
    return request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: order.id, store: store.id, status, customerId })
  }

  test('foreign member cannot be attached by a fulfilment update, and earns nothing at settlement', async () => {
    const foreign = await makeMember({ storeId: otherStore.id })
    const before = await memberState(foreign.id)
    const order = await makeAnonymousQrOrder()

    const res = await updateStatus(order, 'confirmed', foreign.id)

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('MEMBER_OUT_OF_SCOPE')
    const afterUpdate = await db.order.findByPk(order.id)
    expect(afterUpdate.customerId).toBeNull()
    expect(afterUpdate.status).toBe('pending')

    const settle = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'cash', cashAmount: order.totalPrice, changeAmount: 0 })
    expect(settle.status).toBe(200)
    expect(await memberState(foreign.id)).toEqual(before)
  })

  test('foreign member cannot be attached through cancellation', async () => {
    const foreign = await makeMember({ storeId: otherStore.id })
    const order = await makeAnonymousQrOrder()

    const res = await updateStatus(order, 'cancelled', foreign.id)

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('MEMBER_OUT_OF_SCOPE')
    const after = await db.order.findByPk(order.id)
    expect(after.customerId).toBeNull()
    expect(after.status).toBe('pending')
  })

  test('unknown member id cannot be attached by a fulfilment update', async () => {
    const order = await makeAnonymousQrOrder()

    const res = await updateStatus(order, 'confirmed', 2147480004)

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('MEMBER_NOT_FOUND')
    expect((await db.order.findByPk(order.id)).customerId).toBeNull()
  })

  test('same-store member still attaches on a fulfilment update (preserved)', async () => {
    const member = await makeMember({ storeId: store.id })
    const order = await makeAnonymousQrOrder()

    const res = await updateStatus(order, 'confirmed', member.id)

    expect(res.status).toBe(200)
    const after = await db.order.findByPk(order.id)
    expect(Number(after.customerId)).toBe(member.id)
    expect(after.status).toBe('confirmed')
  })
})
