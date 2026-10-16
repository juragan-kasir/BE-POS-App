process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let locationA = null
let locationB = null
let category = null
let product = null
let memberA = null
let memberB = null
let cashierAToken = null
let cashierBToken = null

beforeAll(async () => {
  locationA = await db.location.create({ name: 'REDEEM_STORE_A', status: 'active' })
  locationB = await db.location.create({ name: 'REDEEM_STORE_B', status: 'active' })
  category = await db.category.create({ name: 'REDEEM_CAT' })
  product = await db.product.create({
    nameProduct: 'REDEEM_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100,
    point: 0
  })
  await db.product_store_stock.create({ product: product.id, store: locationA.id, stock: 100 })
  await db.product_store_stock.create({ product: product.id, store: locationB.id, stock: 100 })
  // Create cashier users for FK member_point_history.createdBy
  await db.user.findOrCreate({
    where: { id: 9901 },
    defaults: { userName: 'redeem_cashier_a', roleType: 'kasir', store: locationA.id, password: 'test' }
  })
  await db.user.findOrCreate({
    where: { id: 9902 },
    defaults: { userName: 'redeem_cashier_b', roleType: 'kasir', store: locationB.id, password: 'test' }
  })

  memberA = await db.member.create({
    name: 'REDEEM_MEMBER_A',
    phoneNumber: '081999000001',
    store: locationA.id,
    totalPoints: 2500,
    lifetimePoints: 2500
  })
  memberB = await db.member.create({
    name: 'REDEEM_MEMBER_B',
    phoneNumber: '081999000002',
    store: locationB.id,
    totalPoints: 2500,
    lifetimePoints: 2500
  })

  cashierAToken = await signSessionToken(
    { id: 9901, userName: 'redeem_cashier_a', roleType: 'kasir', store: locationA.id },
    JWT_SECRET
  )
  cashierBToken = await signSessionToken(
    { id: 9902, userName: 'redeem_cashier_b', roleType: 'kasir', store: locationB.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed rates for
  // both stores so these redeem assertions exercise configured tax.
  for (const s of [locationA, locationB]) {
    await db.taxConfig.create({
      name: `REDEEM_PPN_${s.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: s.id
    })
  }
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: locationA.id, user: 9901, status: 'open', openingBalance: 0, openedAt: new Date() })
  await db.cashRegister.create({ store: locationB.id, user: 9902, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: [locationA?.id, locationB?.id].filter(Boolean) }, force: true })
  await db.taxConfig.destroy({
    where: { store: [locationA?.id, locationB?.id].filter(Boolean) },
    force: true
  })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: [locationA.id, locationB.id] }, force: true })
  await db.member_point_history.destroy({ where: { member: [memberA.id, memberB.id] }, force: true })
  await db.member.destroy({ where: { id: [memberA.id, memberB.id] }, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.user.destroy({ where: { id: [9901, 9902] }, force: true })
  await db.location.destroy({ where: { id: [locationA.id, locationB.id] }, force: true })
})

const createOrder = (token, body) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${token}`)
    .send(withIdempotencyKey({
      store: body.store,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'Redeem Cashier',
      ...body
    }))

describe('Phase 18 Member + Redeem', () => {
  test('member found in same store', async () => {
    const res = await request(app)
      .get('/member/get-member')
      .query({ store: locationA.id, nameMember: 'REDEEM_MEMBER_A' })
      .set('Authorization', `Bearer ${cashierAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.some((m) => m.name === 'REDEEM_MEMBER_A')).toBe(true)
  })

  test('store isolation: Store A cashier cannot redeem Store B member', async () => {
    const res = await createOrder(cashierAToken, {
      store: locationA.id,
      customerId: memberB.id,
      redeemedPoints: 100
    })
    // Should be 404 or 400 due to member not found in store scope or insufficient
    expect([400, 403, 404].includes(res.status)).toBe(true)
  })

  test('valid redeem 1000 from 2500 → remaining 1500', async () => {
    const before = (await db.member.findByPk(memberA.id)).totalPoints
    expect(before).toBe(2500)
    const res = await createOrder(cashierAToken, {
      store: locationA.id,
      customerId: memberA.id,
      redeemedPoints: 1000,
      idempotencyKey: `test-redeem-${Date.now()}-1`
    })
    if (res.status !== 201) console.log('VALID REDEEM FAIL BODY:', JSON.stringify(res.body, null, 2))
    expect(res.status).toBe(201)
    expect(res.body.data.totalPrice).toBeDefined()
    const after = (await db.member.findByPk(memberA.id)).totalPoints
    expect(after).toBe(1500)
    // restore for next tests
    await db.member.update({ totalPoints: 2500 }, { where: { id: memberA.id } })
    await db.member_point_history.destroy({ where: { member: memberA.id }, force: true })
    await db.order.destroy({ where: { id: res.body.data.id }, force: true })
  })

  test('redeem exceeds balance → 400', async () => {
    const res = await createOrder(cashierAToken, {
      store: locationA.id,
      customerId: memberA.id,
      redeemedPoints: 3000
    })
    expect(res.status).toBe(400)
    const msg = res.body.message || res.body.error || ''
    expect(msg).toMatch(/Insufficient/i)
  })

  test('negative redeem → 400', async () => {
    const res = await createOrder(cashierAToken, {
      store: locationA.id,
      customerId: memberA.id,
      redeemedPoints: -1
    })
    expect(res.status).toBe(400)
  })

  test('idempotent retry does not double-deduct', async () => {
    const key = `idem-redeem-${Date.now()}`
    const before = (await db.member.findByPk(memberA.id)).totalPoints
    const res1 = await createOrder(cashierAToken, {
      store: locationA.id,
      customerId: memberA.id,
      redeemedPoints: 100,
      idempotencyKey: key
    })
    expect(res1.status).toBe(201)
    const after1 = (await db.member.findByPk(memberA.id)).totalPoints
    const res2 = await createOrder(cashierAToken, {
      store: locationA.id,
      customerId: memberA.id,
      redeemedPoints: 100,
      idempotencyKey: key
    })
    expect(res2.status).toBe(200)
    const after2 = (await db.member.findByPk(memberA.id)).totalPoints
    expect(after1).toBe(before - 100)
    expect(after2).toBe(after1)
    // cleanup
    await db.order.destroy({ where: { id: res1.body.data.id }, force: true })
    await db.member.update({ totalPoints: 2500 }, { where: { id: memberA.id } })
    await db.member_point_history.destroy({ where: { member: memberA.id }, force: true })
  })
})
