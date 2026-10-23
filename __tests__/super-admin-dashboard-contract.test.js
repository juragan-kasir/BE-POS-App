process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Super-admin dashboard response contract (found during B3 runtime testing).
//
// 1. Payment breakdown grouped canonical tenders with legacy regexes:
//    E_WALLET lowercased to 'e_wallet' matched nothing and landed in
//    "other" (CARD too). Buckets must be the canonical methods, with the
//    locked P1 UNRECONCILED bucket for unmappable tenders.
// 2. Unquoted camelCase SQL aliases (AS itemsSold) are folded by Postgres
//    to lowercase, so the camelCase reads were undefined and the API
//    reported itemsSold / serviceCharge / stock value as 0.

const CANONICAL = ['CASH', 'CARD', 'BANK_TRANSFER', 'E_WALLET', 'QRIS', 'POINTS', 'OTHER']
const SUPER_ID = 9982
const unique = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store
let category
let product
let ingredient
let superToken
const orderIds = []

const createPaidOrder = async (typePayment, totalPrice) => {
  const order = await db.order.create({
    orderNumber: unique('DASHC'),
    store: store.id,
    paymentStatus: 'paid',
    totalPrice,
    totalQuantity: 2,
    serviceChargeAmount: 100,
    taxAmount: 0,
    discountAmount: 0
  })
  orderIds.push(order.id)
  await db.transaction.create({ order: order.id, typePayment, amount: totalPrice })
  return order
}

let res

beforeAll(async () => {
  store = await db.location.create({ name: unique('DASHC_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('DASHC_CAT') })
  product = await db.product.create({
    nameProduct: unique('DASHC_PRODUCT'),
    category: category.id,
    price: 5000,
    costPrice: 1000,
    stock: 3,
    status: 'active'
  })
  ingredient = await db.ingredient.create({
    name: unique('DASHC_ING'),
    store: store.id,
    unit: 'pcs',
    baseUnit: 'pcs',
    conversionFactor: 1,
    status: 'active',
    stock: 4,
    costPrice: 2500
  })

  // One paid order per canonical tender (distinct amounts). The DB CHECK
  // refuses unmappable tenders on new writes; legacy UNRECONCILED reporting
  // is covered by the canonical-payment unit tests.
  for (const [i, method] of CANONICAL.entries()) {
    await createPaidOrder(method, 1000 * (i + 1))
  }

  await db.user.create({
    id: SUPER_ID,
    userName: 'super_dash_contract',
    email: 'dash-contract-9982@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'super_dash_contract'
  })
  superToken = await signSessionToken(
    { id: SUPER_ID, userName: 'super_dash_contract', roleType: 'super_admin' },
    JWT_SECRET
  )

  const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const end = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  res = await request(app)
    .get('/pos/dashboard/super-admin')
    .query({ store: store.id, startDate: start, endDate: end })
    .set('Authorization', `Bearer ${superToken}`)
})

afterAll(async () => {
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.ingredient.destroy({ where: { id: ingredient?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: SUPER_ID }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('GET /pos/dashboard/super-admin response contract', () => {
  test('responds 200 for super_admin', () => {
    expect(res.status).toBe(200)
  })

  describe('camelCase SQL aliases reach the API contract', () => {
    test('summary.itemsSold and summary.serviceCharge are summed from paid orders', () => {
      const { summary } = res.body.data
      expect(summary.orders).toBe(7)
      expect(summary.itemsSold).toBe(14)
      expect(summary.serviceCharge).toBe(700)
    })

    test('per-store and daily-trend itemsSold are populated', () => {
      const { storePerformance, kpiTrend } = res.body.data
      const row = storePerformance.find((s) => s.storeId === store.id)
      expect(row.itemsSold).toBe(14)
      expect(kpiTrend.reduce((s, d) => s + d.itemsSold, 0)).toBe(14)
    })

    test('operations stock value includes product and ingredient value', async () => {
      const { operations } = res.body.data
      const [{ productValue }] = await db.sequelize.query(
        `SELECT COALESCE(SUM(stock * "costPrice"),0)::int AS "productValue"
           FROM "product" WHERE status='active' AND "deletedAt" IS NULL`,
        { type: db.sequelize.QueryTypes.SELECT }
      )
      expect(operations.ingredientStockValue).toBe(10000)
      expect(operations.productStockValue).toBe(productValue)
      expect(operations.productStockValue).toBeGreaterThanOrEqual(3000)
      expect(operations.stockValue).toBe(operations.productStockValue + 10000)
    })
  })

  describe('payment breakdown speaks canonical tenders', () => {
    test.each(CANONICAL.map((m, i) => [m, 1000 * (i + 1)]))(
      '%s is its own bucket',
      (method, amount) => {
        const { byType } = res.body.data.paymentBreakdown
        const bucket = byType.find((b) => b.type === method)
        expect(bucket).toEqual(expect.objectContaining({ type: method, count: 1, amount }))
      }
    )

    test('only canonical bucket keys are emitted (no legacy cash/ewallet/bank/card/other)', () => {
      const { byType } = res.body.data.paymentBreakdown
      const types = byType.map((b) => b.type).sort()
      expect(types).toEqual([...CANONICAL].sort())
      expect(types).not.toContain('UNRECONCILED')
    })

    test('byMethod keeps the stored value and carries its canonical bucket', () => {
      const { byMethod } = res.body.data.paymentBreakdown
      const eWallet = byMethod.find((m) => m.method === 'E_WALLET')
      expect(eWallet.bucket).toBe('E_WALLET')
    })

    test('buckets are ordered by amount desc, canonical order on ties', () => {
      const { byType } = res.body.data.paymentBreakdown
      const amounts = byType.map((b) => b.amount)
      expect(amounts).toEqual([...amounts].sort((a, b) => b - a))
    })
  })
})
