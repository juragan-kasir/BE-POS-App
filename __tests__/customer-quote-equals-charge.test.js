process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

// FG-PRICE-02 / FG-PROMO-01: the diner's summary (POST /order/customer-quote)
// comes from the same pricing as the QR order, so an automatic campaign shows
// up by name and the PPN base is the discounted subtotal on both sides.

const tag = `QUOTE_${Date.now()}`
let location
let category
let product
let table
let campaign

beforeAll(async () => {
  location = await db.location.create({ name: `${tag}_STORE`, status: 'active' })
  category = await db.category.create({ name: `${tag}_CAT` })
  product = await db.product.create({
    nameProduct: `${tag}_PRODUCT`,
    category: category.id,
    price: 50000,
    stock: 100
  })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 100 })
  table = await db.table.create({ store: location.id, name: `${tag}_TABLE`, capacity: 4 })
  await db.taxConfig.create({ name: `${tag}_PPN`, rate: 11, type: 'ppn', status: 'active', store: location.id })
  campaign = await db.promo_campaign.create({
    name: `${tag} Diskon 10%`,
    type: 'automatic',
    status: 'active',
    store: [location.id],
    startDate: new Date(Date.now() - 3600000),
    endDate: new Date(Date.now() + 86400000),
    currentUsage: 0,
    priority: 999
  })
  await db.promo_reward.create({
    campaignId: campaign.id,
    rewardType: 'discount_percentage',
    rewardValue: 10,
    isActive: true
  })
})

afterAll(async () => {
  const orders = await db.order.findAll({ where: { store: location.id }, attributes: ['id'] })
  const ids = orders.map((o) => o.id)
  await db.auditLog.destroy({ where: { storeId: location.id }, force: true, __auditMaintenance: true }).catch(() => {})
  await db.notification.destroy({ where: { store: location.id }, force: true }).catch(() => {})
  await db.order_item.destroy({ where: { order: ids }, force: true })
  await db.order_status.destroy({ where: { order: ids }, force: true })
  await db.order.destroy({ where: { id: ids }, force: true })
  await db.promo_reward.destroy({ where: { campaignId: campaign.id }, force: true })
  await db.promo_campaign.destroy({ where: { id: campaign.id }, force: true })
  await db.taxConfig.destroy({ where: { store: location.id }, force: true })
  await db.table.destroy({ where: { id: table.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

const items = () => [{ productId: product.id, productName: `${tag}_PRODUCT`, quantity: 2 }]

test('the quote names the automatic campaign and taxes the discounted subtotal', async () => {
  const res = await request(app).post('/order/customer-quote').send({ store: location.id, items: items() })
  expect(res.status).toBe(200)
  const q = res.body.data
  expect(q.subTotal).toBe(100000)
  expect(q.discountAmount).toBe(10000)
  expect(q.discountApplied).toEqual([{ campaignId: campaign.id, name: `${tag} Diskon 10%`, amount: 10000 }])
  expect(q.taxRate).toBe(11)
  expect(q.taxAmount).toBe(9900) // 11 % of 90,000 — not of 100,000
  expect(q.serviceChargeAmount).toBe(0)
  expect(q.totalPrice).toBe(99900)
  expect(q.items[0]).toMatchObject({ unitPrice: 50000, subtotal: 100000, quantity: 2 })
})

test('the QR order charges exactly the quoted total', async () => {
  const quote = (await request(app).post('/order/customer-quote').send({ store: location.id, items: items() })).body.data
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: location.id,
      tableId: table.id,
      customerName: 'Quote test',
      items: items(),
      session: `${tag}-${Math.random()}`
    })
  expect(res.status).toBe(201)
  const order = res.body.data
  expect(Number(order.subTotal)).toBe(quote.subTotal)
  expect(Number(order.discountAmount)).toBe(quote.discountAmount)
  expect(Number(order.taxAmount)).toBe(quote.taxAmount)
  expect(Number(order.totalPrice)).toBe(quote.totalPrice)
})

test('the quote refuses what the order would refuse and writes nothing', async () => {
  const before = await db.order.count({ where: { store: location.id } })
  expect((await request(app).post('/order/customer-quote').send({ store: location.id, items: [] })).status).toBe(400)
  expect(
    (await request(app).post('/order/customer-quote').send({ store: location.id, items: [{ productId: 999999999, quantity: 1 }] })).status
  ).toBe(400)
  expect(
    (await request(app).post('/order/customer-quote').send({ store: location.id, items: [{ productId: product.id, quantity: 0 }] })).status
  ).toBe(400)
  expect(
    (await request(app).post('/order/customer-quote').send({ store: location.id, items: [{ productId: product.id, quantity: 1, priceOverride: 1 }] })).status
  ).toBe(403)
  expect(await db.order.count({ where: { store: location.id } })).toBe(before)
})

test('a campaign restricted to today is listed for diners (daysOfWeek is 0–6)', async () => {
  const today = new Date().getDay()
  const dayCampaign = await db.promo_campaign.create({
    name: `${tag} Hari ini`,
    type: 'automatic',
    status: 'active',
    store: [location.id],
    startDate: new Date(Date.now() - 3600000),
    endDate: new Date(Date.now() + 86400000),
    daysOfWeek: [today],
    currentUsage: 0,
    priority: 1
  })
  try {
    const res = await request(app).get('/promo/customer-active').query({ store: location.id })
    expect(res.status).toBe(200)
    expect(res.body.data.map((c) => c.id)).toContain(dayCampaign.id)
  } finally {
    await db.promo_campaign.destroy({ where: { id: dayCampaign.id }, force: true })
  }
})
