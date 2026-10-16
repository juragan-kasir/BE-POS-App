process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-RET-2 regression: concurrent approval activity must serialize on the
// return/order row locks with deterministic product-lock ordering —
// exactly one stock restoration per return, no deadlocks surfacing as
// 500s, no torn state. Invariant-based (no timing assertions, no sleeps).

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let category = null
let adminToken = null
let productA = null
let productB = null

async function makeProduct(name) {
  const p = await db.product.create({
    nameProduct: name,
    category: category.id,
    price: 10000,
    stock: 50
  })
  await db.product_store_stock.create({
    product: p.id,
    store: store.id,
    stock: 50
  })
  return p
}

async function sell(items) {
  const res = await request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(withIdempotencyKey({
      store: store.id,
      items,
      paymentMethod: 'cash',
      cashierName: 'Race Cashier',
      idempotencyKey: unique('racesell')
    }))
  if (res.status !== 201) throw new Error('sale setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function makeReturn(orderId, items) {
  const res = await request(app)
    .post(`/pos/order/${orderId}/return`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ items, reason: 'race probe', idempotencyKey: unique('raceret') })
  return res
}

async function approve(retId) {
  return request(app)
    .patch(`/sales-return/approve/${retId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ id: retId })
}

async function fgStock(productId) {
  return Number((await db.product.findByPk(productId)).stock)
}

beforeAll(async () => {
  store = await db.location.create({ name: `RACE_STORE_${Date.now()}`, status: 'active' })
  category = await db.category.create({ name: `RACE_CAT_${Date.now()}` })
  productA = await makeProduct(`RACE_A_${Date.now()}`)
  productB = await makeProduct(`RACE_B_${Date.now()}`)
  const adminUser = await db.user.create({
    userName: `admin_race_${Date.now()}`,
    email: `admin_race_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: store.id, user: adminUser.id, status: 'open', openingBalance: 0, openedAt: new Date() })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these approval assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'RACE_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.stock_history.destroy({ where: { store: store?.id }, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.sales_return_item.destroy({ where: {}, force: true })
  await db.sales_return.destroy({ where: { store: store?.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store?.id }, force: true })
  await db.product.destroy({
    where: { id: [productA?.id, productB?.id].filter(Boolean) },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F-RET-2 approval concurrency', () => {
  test('Test G — concurrent approves of one return: exactly one succeeds, one restoration', async () => {
    const baseline = await fgStock(productA.id)
    const order = await sell([{ product: productA.id, quantity: 3, productName: 'a' }])
    const created = await makeReturn(order.id, [
      { productId: productA.id, orderItemId: order.items[0].id, qty: 3 }
    ])
    expect([200, 201]).toContain(created.status)
    const retId = created.body.data.id

    const [r1, r2] = await Promise.all([approve(retId), approve(retId)])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    expect(await fgStock(productA.id)).toBe(baseline)
  })

  test('Test H — concurrent duplicate creates: pending reservation blocks the second, single restoration', async () => {
    const baseline = await fgStock(productA.id)
    const order = await sell([{ product: productA.id, quantity: 3, productName: 'a' }])
    const item = { productId: productA.id, orderItemId: order.items[0].id }

    // Each return is individually valid (2 ≤ 3); combined they exceed the
    // sold quantity. Creation serializes on the order lock and counts
    // pending reservations, so the loser must fail at create time.
    const [c1, c2] = await Promise.all([
      makeReturn(order.id, [{ ...item, qty: 2 }]),
      makeReturn(order.id, [{ ...item, qty: 2 }])
    ])
    const createStatuses = [c1.status, c2.status].sort()
    expect(createStatuses).toEqual([201, 409])

    const winner = [c1, c2].find((r) => [200, 201].includes(r.status))
    const approved = await approve(winner.body.data.id)
    expect(approved.status).toBe(200)
    // Exactly the winner's 2 units restored — never 4.
    expect(await fgStock(productA.id)).toBe(baseline - 1)
  })

  test('Test I — multi-product return under contention: serialized, exact, no 500s', async () => {
    const baseA = await fgStock(productA.id)
    const baseB = await fgStock(productB.id)
    const order = await sell([
      { product: productA.id, quantity: 2, productName: 'a' },
      { product: productB.id, quantity: 2, productName: 'b' }
    ])
    const items = [
      { productId: productA.id, orderItemId: order.items[0].id, qty: 2 },
      { productId: productB.id, orderItemId: order.items[1].id, qty: 2 }
    ]
    const created = await makeReturn(order.id, items)
    expect([200, 201]).toContain(created.status)
    const retId = created.body.data.id

    const [r1, r2] = await Promise.all([approve(retId), approve(retId)])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    expect(await fgStock(productA.id)).toBe(baseA)
    expect(await fgStock(productB.id)).toBe(baseB)
  })
})
