process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// DR-11 (server-resolved price is the price of record; no silent
// substitution) and DR-17 (one resolver; displayed = charged): POST
// /order/quote returns what /order/create will charge for the same
// payload, computed by the same resolver, and writes nothing.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const PRICE = 50000
const TIER_PERCENT = 10
const DISCOUNT_NOMINAL = 5000

let store = null
let otherStore = null
let category = null
let product = null
let tier = null
let manualDiscount = null
let adminToken = null
const memberIds = []

const as = () => ({ Authorization: `Bearer ${adminToken}` })

async function makeMember({ storeId = store.id, tierId = null, totalPoints = 0 } = {}) {
  const m = await db.member.create({
    name: unique('QUOTE_MEMBER'),
    phoneNumber: `08${Math.floor(1e9 + Math.random() * 9e9)}`,
    store: storeId,
    tier: tierId,
    totalPoints,
    lifetimePoints: totalPoints,
    status: 'active'
  })
  memberIds.push(m.id)
  return m
}

const basePayload = (extra = {}) => ({
  store: store.id,
  items: [{ product: product.id, quantity: 2 }],
  ...extra
})

const quote = (payload) => request(app).post('/order/quote').set(as()).send(payload)

async function createWithExactCash(payload, total) {
  return request(app)
    .post('/order/create')
    .set(as())
    .send(withIdempotencyKey({
      ...payload,
      paymentMethod: 'cash',
      cashierName: 'Quote Cashier',
      idempotencyKey: unique('quote'),
      cashAmount: total,
      changeAmount: 0
    }))
}

async function snapshot() {
  const stock = await db.product_store_stock.findOne({ where: { product: product.id, store: store.id } })
  return {
    orders: await db.order.count({ where: { store: store.id } }),
    stock: Number(stock.stock),
    pointRows: await db.member_point_history.count({ where: { member: memberIds } })
  }
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('QUOTE_STORE'), status: 'active' })
  otherStore = await db.location.create({ name: unique('QUOTE_OTHER'), status: 'active' })
  category = await db.category.create({ name: unique('QUOTE_CAT') })
  product = await db.product.create({
    nameProduct: unique('QUOTE_PRODUCT'),
    category: category.id,
    price: PRICE,
    point: 1,
    stock: 1000
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.taxConfig.create({ store: store.id, name: unique('QUOTE_PPN'), rate: 11, type: 'ppn', status: 'active' })
  tier = await db.member_tier.create({
    store: store.id,
    name: unique('QUOTE_TIER'),
    minPoints: 0,
    maxPoints: 1000000,
    discountPercent: TIER_PERCENT,
    status: 'active'
  })
  manualDiscount = await db.discount.create({
    store: store.id,
    name: unique('QUOTE_DISC'),
    type: 'nominal',
    value: DISCOUNT_NOMINAL,
    status: 'active'
  })
  const admin = await db.user.create({
    userName: unique('quote_admin'),
    email: `${unique('quote_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  const openRes = await request(app)
    .post('/cash-register/open')
    .set(as())
    .send({ store: store.id, openingBalance: 100000, shift: 1 })
  if (![200, 201].includes(openRes.status)) {
    throw new Error('register setup failed: ' + JSON.stringify(openRes.body))
  }
})

afterAll(async () => {
  const stores = [store?.id, otherStore?.id].filter(Boolean)
  const orderIds = (await db.order.findAll({ where: { store: stores }, attributes: ['id'] })).map((o) => o.id)
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.stock_history.destroy({ where: { store: stores }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.member_point_history.destroy({ where: { member: memberIds }, force: true })
  await db.member.destroy({ where: { id: memberIds }, force: true })
  await db.member_tier.destroy({ where: { store: stores }, force: true })
  await db.discount.destroy({ where: { store: stores }, force: true })
  await db.cashRegister.destroy({ where: { store: stores }, force: true })
  await db.taxConfig.destroy({ where: { store: stores }, force: true })
  await db.product_store_stock.destroy({ where: { store: stores }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: stores }, force: true })
  await db.location.destroy({ where: { id: stores }, force: true })
})

describe('POST /order/quote — the quoted total is the charged total', () => {
  const scenarios = [
    ['no member, no discount', () => basePayload(), 'none'],
    ['tier member (tier discount applies)', async () => {
      const m = await makeMember({ tierId: tier.id })
      return basePayload({ customerId: m.id })
    }, 'tier'],
    ['tier member + explicit discount (discount wins; tier is not stacked)', async () => {
      const m = await makeMember({ tierId: tier.id })
      return basePayload({ customerId: m.id, discountId: manualDiscount.id })
    }, 'discount'],
    ['tax switched off', () => basePayload({ useTax: false }), 'none'],
    ['points redeemed (reduce the taxable base)', async () => {
      const m = await makeMember({ totalPoints: 10000 })
      return basePayload({ customerId: m.id, redeemedPoints: 3000 })
    }, 'none']
  ]

  test.each(scenarios)('%s', async (_name, build, source) => {
    const payload = await build()

    const q = await quote(payload)
    expect(q.status).toBe(200)
    expect(q.body.data.discountSource).toBe(source)

    const created = await createWithExactCash(payload, q.body.data.totalPrice)
    expect(created.status).toBe(201)
    for (const key of ['subTotal', 'discountAmount', 'taxAmount', 'serviceChargeAmount', 'totalPrice']) {
      expect(Number(created.body.data[key])).toBe(Number(q.body.data[key]))
    }
  })

  test('tier and an explicit discount are not stacked', async () => {
    const m = await makeMember({ tierId: tier.id })
    const q = await quote(basePayload({ customerId: m.id, discountId: manualDiscount.id }))

    expect(q.status).toBe(200)
    expect(q.body.data.discountAmount).toBe(DISCOUNT_NOMINAL)
  })
})

describe('POST /order/quote — read-only and refused like create', () => {
  test('a quote writes no order, stock or loyalty effect', async () => {
    const m = await makeMember({ tierId: tier.id, totalPoints: 10000 })
    const before = await snapshot()

    const q = await quote(basePayload({ customerId: m.id, redeemedPoints: 1000 }))

    expect(q.status).toBe(200)
    expect(await snapshot()).toEqual(before)
    expect(Number((await db.member.findByPk(m.id)).totalPoints)).toBe(10000)
  })

  test('a foreign-store member is refused, exactly as create refuses it', async () => {
    const foreign = await makeMember({ storeId: otherStore.id, tierId: tier.id })

    const q = await quote(basePayload({ customerId: foreign.id }))

    expect(q.status).toBe(403)
    expect(q.body.code).toBe('MEMBER_OUT_OF_SCOPE')
  })

  test('another store cannot be quoted by a store-pinned user (same refusal as create)', async () => {
    const payload = { ...basePayload(), store: otherStore.id }
    const q = await quote(payload)
    const c = await createWithExactCash(payload, PRICE)

    expect([401, 403]).toContain(q.status)
    expect(q.status).toBe(c.status)
  })

  test('a stale expected price is refused with the locked price-mismatch body', async () => {
    const q = await quote({
      store: store.id,
      items: [{ product: product.id, quantity: 1, expectedPrice: PRICE - 1 }]
    })
    expect(q.status).toBe(409)
  })

  test('unauthenticated quote is refused', async () => {
    const res = await request(app).post('/order/quote').send(basePayload())
    expect(res.status).toBe(401)
  })
})
