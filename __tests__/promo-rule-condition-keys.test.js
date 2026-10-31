process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const {
  buyXGetYCondition,
  spendThreshold,
  isActiveOnDay
} = require('../utils/promoRuleCondition')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// The FE promo form stores rule conditions as { productIdX, qtyX, ... }
// and { minAmount }, but the checkout read { buyProductId, buyQuantity }
// and { minSpend }: spend-threshold promos then applied to any subtotal
// and buy-X-get-Y promos never applied. These pin the checkout (via the
// quote, which runs the same evaluation) to the form's keys.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const PRICE = 50000

let store = null
let category = null
let product = null
let adminToken = null

const quote = (quantity) =>
  request(app)
    .post('/order/quote')
    .set({ Authorization: `Bearer ${adminToken}` })
    .send({ store: store.id, items: [{ product: product.id, quantity }] })

const withCampaign = async (rule, rewardValue, run) => {
  const campaign = await db.promo_campaign.create({
    name: unique('PRC_CAMPAIGN'),
    type: 'automatic',
    status: 'active',
    store: [store.id],
    startDate: new Date(Date.now() - 3600000),
    endDate: new Date(Date.now() + 86400000),
    currentUsage: 0,
    priority: 999
  })
  await db.promo_rule.create({ campaignId: campaign.id, ...rule, isActive: true })
  await db.promo_reward.create({
    campaignId: campaign.id,
    rewardType: 'discount_fixed',
    rewardValue,
    isActive: true
  })
  try {
    await run()
  } finally {
    await db.promo_rule.destroy({ where: { campaignId: campaign.id }, force: true })
    await db.promo_reward.destroy({ where: { campaignId: campaign.id }, force: true })
    await db.promo_campaign.destroy({ where: { id: campaign.id }, force: true })
  }
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('PRC_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('PRC_CAT') })
  product = await db.product.create({
    nameProduct: unique('PRC_PRODUCT'),
    category: category.id,
    price: PRICE,
    stock: 1000
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.taxConfig.create({
    store: store.id,
    name: unique('PRC_PPN'),
    rate: 11,
    type: 'ppn',
    status: 'active'
  })
  const admin = await db.user.create({
    userName: unique('prc_admin'),
    email: `${unique('prc_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

describe('promo rule conditions at checkout', () => {
  test('a spend threshold from the form (minAmount) is enforced', async () => {
    await withCampaign(
      { ruleType: 'spend_threshold', condition: { minAmount: 200000 } },
      1000,
      async () => {
        const below = await quote(2)
        expect(below.status).toBe(200)
        expect(below.body.data.discountAmount).toBe(0)
        const above = await quote(5)
        expect(above.body.data.discountAmount).toBe(1000)
      }
    )
  })

  test('a buy-X rule from the form (productIdX, qtyX) applies once X is bought', async () => {
    await withCampaign(
      {
        ruleType: 'buy_x_get_y',
        condition: { productIdX: product.id, qtyX: 3, productIdY: product.id, qtyY: 1 }
      },
      2000,
      async () => {
        const short = await quote(2)
        expect(short.body.data.discountAmount).toBe(0)
        const enough = await quote(3)
        expect(enough.body.data.discountAmount).toBe(2000)
      }
    )
  })
})

describe('promoRuleCondition helpers', () => {
  test('the form keys win over the legacy keys', () => {
    expect(buyXGetYCondition({ productIdX: 5, qtyX: 2, buyProductId: 9, buyQuantity: 7 })).toEqual({
      buyProductId: 5,
      buyQuantity: 2
    })
    expect(spendThreshold({ minAmount: 100, minSpend: 900 })).toBe(100)
  })

  test('legacy keys still work', () => {
    expect(buyXGetYCondition({ buyProductId: 9, buyQuantity: 7 })).toEqual({
      buyProductId: 9,
      buyQuantity: 7
    })
    expect(spendThreshold({ minSpend: 900 })).toBe(900)
    expect(spendThreshold(null)).toBe(0)
  })

  test('empty or missing active days mean every day', () => {
    expect(isActiveOnDay([], 3)).toBe(true)
    expect(isActiveOnDay(null, 3)).toBe(true)
    expect(isActiveOnDay([1, 2], 3)).toBe(false)
    expect(isActiveOnDay([3], 3)).toBe(true)
  })
})
