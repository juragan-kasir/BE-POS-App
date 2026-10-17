process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// P1-8: the per-member promo cap must hold at record time, not just at
// evaluation time. Two concurrent checkouts for the same member against a
// maxUsagePerMember=1 campaign must leave exactly one usage row — the
// loser is refused instead of over-redeeming.

let store = null
let category = null
let product = null
let adminToken = null
let counter = 0
const campaignIds = []
const memberIds = []

const nextTag = () => {
  counter += 1
  return `PMC-${Date.now()}-${counter}`
}

const auth = (token) => ({ Authorization: `Bearer ${token}` })

const makeMember = () =>
  db.member
    .create({ name: nextTag(), phoneNumber: `08${Date.now()}${counter}`, totalPoints: 0 })
    .then((m) => {
      memberIds.push(m.id)
      return m
    })

const makeCampaign = (overrides = {}, rewardValue = 1000) =>
  db.promo_campaign
    .create({
      name: nextTag(),
      type: 'automatic',
      status: 'active',
      startDate: new Date(Date.now() - 3600000),
      endDate: new Date(Date.now() + 86400000),
      maxUsagePerMember: 1,
      currentUsage: 0,
      priority: 999,
      ...overrides
    })
    .then(async (campaign) => {
      campaignIds.push(campaign.id)
      await db.promo_reward.create({
        campaignId: campaign.id,
        rewardType: 'discount_fixed',
        rewardValue,
        isActive: true
      })
      return campaign
    })

const sell = (token, memberId, key) =>
  request(app)
    .post('/order/create')
    .set(auth(token))
    .send({
      store: store.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'PMC',
      customerId: memberId,
      idempotencyKey: key
    })

beforeAll(async () => {
  store = await db.location.create({ name: `PMC_STORE_${Date.now()}`, status: 'active' })
  category = await db.category.create({ name: `PMC_CAT_${Date.now()}` })
  product = await db.product.create({
    nameProduct: `PMC_PROD_${Date.now()}`,
    category: category.id,
    price: 20000,
    stock: 1000,
    inventoryMode: 'stocked'
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.user.create({
    id: 7981,
    userName: `pmc_admin_${Date.now()}`,
    email: `pmc_admin_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'PMC Admin'
  })
  adminToken = await signSessionToken(
    { id: 7981, userName: 'pmc_admin', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  await db.taxConfig.create({
    name: `PMC_PPN_${store.id}`,
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  await db.cashRegister.destroy({ where: { store: store.id, status: 'open' }, force: true })
  await db.cashRegister.create({
    store: store.id,
    user: 7981,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
})

afterAll(async () => {
  const orderIds = await db.order
    .findAll({ where: { store: store.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  if (orderIds.length) {
    await db.stock_history.destroy({ where: { referenceId: orderIds }, force: true })
    await db.order_item.destroy({ where: { order: orderIds }, force: true })
    await db.transaction.destroy({ where: { order: orderIds }, force: true })
    await db.order_status.destroy({ where: { order: orderIds }, force: true })
  }
  await db.promo_usage.destroy({ where: { campaignId: campaignIds }, force: true })
  await db.order.destroy({ where: { store: store.id }, force: true })
  await db.promo_reward.destroy({ where: { campaignId: campaignIds }, force: true })
  await db.promo_campaign.destroy({ where: { id: campaignIds }, force: true })
  await db.best_selling.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.member.destroy({ where: { id: memberIds }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.user.destroy({ where: { id: [7981] }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

describe('P1-8 — per-member promo cap holds under concurrency', () => {
  test('an exhausted cap skips the promo: full-price sale, no new usage', async () => {
    const member = await makeMember()
    const campaign = await makeCampaign()
    await db.promo_usage.create({
      campaignId: campaign.id,
      memberId: member.id,
      discountApplied: 1000,
      store: store.id
    })

    const res = await sell(adminToken, member.id, `pmc-exhausted-${Date.now()}`)
    expect(res.status).toBe(201)
    expect(
      await db.promo_usage.count({ where: { campaignId: campaign.id, memberId: member.id } })
    ).toBe(1)
  })

  test('two concurrent checkouts: exactly one gets the discount', async () => {
    const member = await makeMember()
    // Strictly best discount so evaluation deterministically picks this
    // campaign (not another active one from this file).
    const campaign = await makeCampaign({}, 5000)
    const key = Date.now()

    const [r1, r2] = await Promise.all([
      sell(adminToken, member.id, `pmc-race-a-${key}`),
      sell(adminToken, member.id, `pmc-race-b-${key}`)
    ])
    expect([r1.status, r2.status].sort()).toEqual([201, 409])
    expect(
      await db.promo_usage.count({ where: { campaignId: campaign.id, memberId: member.id } })
    ).toBe(1)
    expect(await db.order.count({ where: { store: store.id, customerId: member.id } })).toBe(1)
  })
})
