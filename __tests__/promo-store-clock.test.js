// The store keeps a timezone far from both UTC (Vercel) and WIB (a dev
// machine), so a promo window read off the server clock misses it.
process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { getStoreClock } = require('../utils/businessDate')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const HOUR_MS = 3600000
const STORE_TIMEZONE = 'Pacific/Kiritimati'

let store = null
let category = null
let product = null
let adminToken = null

const clockAt = (offsetMs) => getStoreClock(STORE_TIMEZONE, new Date(Date.now() + offsetMs)).time
const windowAroundStoreNow = () => {
  const now = clockAt(0)
  const start = clockAt(-HOUR_MS)
  const end = clockAt(HOUR_MS)
  return { startTime: start < now ? start : '00:00:00', endTime: end > now ? end : '23:59:59' }
}

beforeAll(async () => {
  store = await db.location.create({
    name: unique('PSC_STORE'),
    status: 'active',
    timezone: STORE_TIMEZONE
  })
  category = await db.category.create({ name: unique('PSC_CAT') })
  product = await db.product.create({
    nameProduct: unique('PSC_PRODUCT'),
    category: category.id,
    price: 50000,
    stock: 1000
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.taxConfig.create({
    store: store.id,
    name: unique('PSC_PPN'),
    rate: 11,
    type: 'ppn',
    status: 'active'
  })
  const admin = await db.user.create({
    userName: unique('psc_admin'),
    email: `${unique('psc_admin')}@test.com`,
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
  const campaigns = await db.promo_campaign.findAll({ where: { name: { [db.Sequelize.Op.like]: 'PSC_%' } } })
  const ids = campaigns.map((c) => c.id)
  await db.promo_reward.destroy({ where: { campaignId: ids }, force: true })
  await db.promo_campaign.destroy({ where: { id: ids }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

test('a happy hour set in store time applies during that store hour', async () => {
  const campaign = await db.promo_campaign.create({
    name: unique('PSC_HAPPY'),
    type: 'happy_hour',
    status: 'active',
    store: [store.id],
    startDate: new Date(Date.now() - 86400000),
    endDate: new Date(Date.now() + 86400000),
    ...windowAroundStoreNow(),
    currentUsage: 0,
    priority: 999
  })
  await db.promo_reward.create({
    campaignId: campaign.id,
    rewardType: 'discount_fixed',
    rewardValue: 3000,
    isActive: true
  })
  const res = await request(app)
    .post('/order/quote')
    .set({ Authorization: `Bearer ${adminToken}` })
    .send({ store: store.id, items: [{ product: product.id, quantity: 1 }] })
  expect(res.status).toBe(200)
  expect(res.body.data.discountAmount).toBe(3000)
})
