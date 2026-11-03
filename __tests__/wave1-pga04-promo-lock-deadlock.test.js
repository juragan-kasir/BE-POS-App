process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { incrementPromoUsage } = require('../api/service/promoUsageService')
const { withIdempotencyKey } = require('../test-helpers/idempotency')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// PGA-04 (audit product-grade-2026-11-02, 60-load-run1-deadlock.json):
// checkout deadlocked under load while a campaign was active — 428
// deadlocks, 233 × 500 on /order/create, only 32 orders in 8 minutes.
//
// Cause: the order row is inserted with promoCampaignId (FK →
// promo_campaign), which holds FOR KEY SHARE on the campaign row until
// commit; the usage increment then asked for FOR UPDATE on that same row.
// FOR UPDATE conflicts with KEY SHARE, so two checkouts using one campaign
// waited on each other. The increment now takes FOR NO KEY UPDATE.

const PREFIX = `w1p4_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const DAY = 86400000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ids = { tenants: [], stores: [], users: [], products: [], categories: [], campaigns: [], orders: [] }
const s = {}

beforeAll(async () => {
  const tenant = await db.tenant.create({ code: unique('T').toUpperCase(), name: unique('Tenant') })
  ids.tenants.push(tenant.id)
  s.stores = []
  for (const key of ['S1', 'S2']) {
    const store = await db.location.create({ name: unique(key), status: 'active', tenantId: tenant.id })
    ids.stores.push(store.id)
    s.stores.push(store)
  }
  s.category = await db.category.create({ name: unique('CAT'), status: 'active' })
  ids.categories.push(s.category.id)
  s.product = await db.product.create({ nameProduct: unique('PROD'), category: s.category.id, price: 20000, stock: 100000 })
  ids.products.push(s.product.id)

  s.tokens = []
  for (const store of s.stores) {
    await db.product_store.create({ product: s.product.id, store: store.id })
    await db.product_store_stock.create({ product: s.product.id, store: store.id, stock: 100000 })
    await db.taxConfig.create({ store: store.id, name: unique('PPN'), rate: 11, type: 'ppn', status: 'active' })
    const user = await db.user.create({
      userName: unique('admin'),
      email: `${unique('admin')}@test.com`,
      password: 'Rahasia123!',
      fullName: unique('admin'),
      roleType: 'admin',
      userType: 'admin',
      status: 'active',
      store: store.id
    })
    ids.users.push(user.id)
    await db.cashRegister.create({ store: store.id, user: user.id, status: 'open', openingBalance: 0, openedAt: new Date() })
    s.tokens.push(await signSessionToken({ id: user.id, roleType: 'admin', store: store.id }, JWT_SECRET))
  }

  s.campaign = await db.promo_campaign.create({
    name: unique('CAMPAIGN'),
    type: 'manual',
    status: 'active',
    store: null,
    tenantId: tenant.id,
    startDate: new Date(Date.now() - DAY),
    endDate: new Date(Date.now() + DAY),
    currentUsage: 0,
    priority: 999
  })
  ids.campaigns.push(s.campaign.id)
  await db.promo_reward.create({ campaignId: s.campaign.id, rewardType: 'discount_fixed', rewardValue: 1000, isActive: true })
})

afterAll(async () => {
  const orders = await db.order.findAll({ where: { store: ids.stores }, attributes: ['id'], raw: true })
  const orderIds = [...new Set([...ids.orders, ...orders.map((o) => o.id)])]
  await db.promo_usage.destroy({ where: { campaignId: ids.campaigns }, force: true })
  for (const model of ['transaction', 'order_item', 'order_status']) {
    await db[model]?.destroy({ where: { order: orderIds }, force: true }).catch(() => {})
  }
  await db.order.destroy({ where: { id: orderIds }, force: true }).catch(() => {})
  await db.promo_reward.destroy({ where: { campaignId: ids.campaigns }, force: true })
  await db.promo_campaign.destroy({ where: { id: ids.campaigns }, force: true })
  // Sales leave ledger/stock rows behind; the fixtures are uniquely named,
  // so a failed best-effort cleanup never collides with another run.
  const quiet = (p) => p.catch(() => {})
  await quiet(db.cashRegister.destroy({ where: { store: ids.stores }, force: true }))
  await quiet(db.taxConfig.destroy({ where: { store: ids.stores }, force: true }))
  await quiet(db.product_store_stock.destroy({ where: { product: ids.products }, force: true }))
  await quiet(db.product_store.destroy({ where: { product: ids.products } }))
  await quiet(db.product.destroy({ where: { id: ids.products }, force: true }))
  await quiet(db.category.destroy({ where: { id: ids.categories }, force: true }))
  await quiet(db.user.destroy({ where: { id: ids.users }, force: true }))
  await quiet(db.location.destroy({ where: { id: ids.stores }, force: true }))
  await quiet(db.tenant.destroy({ where: { id: ids.tenants }, force: true }))
})

const insertOrder = (store, transaction) =>
  db.order.create(
    {
      orderNumber: unique('ORD'),
      store: store.id,
      status: 'pending',
      paymentStatus: 'paid',
      source: 'pos',
      promoCampaignId: s.campaign.id
    },
    { transaction }
  )

test('two checkouts holding the campaign FK both record their usage, no deadlock', async () => {
  const before = Number((await db.promo_campaign.findByPk(s.campaign.id)).currentUsage)
  const tA = await db.sequelize.transaction()
  const tB = await db.sequelize.transaction()
  try {
    // Both orders reference the campaign: each transaction now holds
    // FOR KEY SHARE on the campaign row (the FK check), as in checkout.
    const orderA = await insertOrder(s.stores[0], tA)
    const orderB = await insertOrder(s.stores[1], tB)
    ids.orders.push(orderA.id, orderB.id)

    // A's increment must not wait on B's KEY SHARE (it did with FOR UPDATE).
    const pA = incrementPromoUsage({ campaignId: s.campaign.id, orderId: orderA.id, transaction: tA })
    await sleep(150)
    const pB = incrementPromoUsage({ campaignId: s.campaign.id, orderId: orderB.id, transaction: tB })

    const rA = await pA
    expect(rA.usage).toBeTruthy()
    await tA.commit()
    const rB = await pB
    expect(rB.usage).toBeTruthy()
    await tB.commit()
  } catch (error) {
    await tA.rollback().catch(() => {})
    await tB.rollback().catch(() => {})
    throw error
  }
  const after = Number((await db.promo_campaign.findByPk(s.campaign.id)).currentUsage)
  expect(after).toBe(before + 2)
})

test('the increment still serializes: a capped campaign is never over-redeemed', async () => {
  await db.promo_campaign.update(
    { maxUsageTotal: Number((await db.promo_campaign.findByPk(s.campaign.id)).currentUsage) + 1 },
    { where: { id: s.campaign.id } }
  )
  const tA = await db.sequelize.transaction()
  const tB = await db.sequelize.transaction()
  try {
    const orderA = await insertOrder(s.stores[0], tA)
    const orderB = await insertOrder(s.stores[1], tB)
    ids.orders.push(orderA.id, orderB.id)
    const rA = await incrementPromoUsage({ campaignId: s.campaign.id, orderId: orderA.id, transaction: tA })
    const pB = incrementPromoUsage({ campaignId: s.campaign.id, orderId: orderB.id, transaction: tB })
    await sleep(150)
    await tA.commit()
    const rB = await pB
    await tB.commit()
    expect(rA.usage).toBeTruthy()
    expect(rB.limitReached).toBe(true)
  } catch (error) {
    await tA.rollback().catch(() => {})
    await tB.rollback().catch(() => {})
    throw error
  } finally {
    await db.promo_campaign.update({ maxUsageTotal: null }, { where: { id: s.campaign.id } })
  }
})

test('parallel counter sales at two outlets with the campaign: all succeed, usage exact', async () => {
  const before = Number((await db.promo_campaign.findByPk(s.campaign.id)).currentUsage)
  const N = 16
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => {
      const k = i % 2
      return request(app)
        .post('/order/create')
        .set({ Authorization: `Bearer ${s.tokens[k]}` })
        .send(withIdempotencyKey({
          store: s.stores[k].id,
          items: [{ product: s.product.id, quantity: 1 }],
          paymentMethod: 'cash',
          cashReceived: 100000,
          cashierName: 'PGA04'
        }))
    })
  )
  const statuses = results.map((r) => r.status)
  expect(statuses.filter((code) => code >= 500)).toEqual([])
  expect(statuses.every((code) => code === 201)).toBe(true)
  const after = Number((await db.promo_campaign.findByPk(s.campaign.id)).currentUsage)
  expect(after).toBe(before + N)
})
