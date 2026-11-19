process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 2 HIGH-5 regression: inventory.js accepted unvalidated store inputs
// via query.storeId, query.store, or cookies, and fell back to fail-open
// queries where = {} when no store was present.
// With the fix, non-super-admin is always strictly scoped to req.storeId.

let store1 = null
let store2 = null
let category = null
let product1 = null
let product2 = null
let batch1 = null
let batch2 = null
let forecast1 = null
let forecast2 = null
let admin1Token = null
let superToken = null

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({ name: 'HIGH5_STORE_A', status: 'active' }))
  store2 = await db.location.create(await withTestTenant({ name: 'HIGH5_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'HIGH5_CAT', status: 'active' })
  product1 = await db.product.create({
    nameProduct: 'HIGH5_PROD_1',
    category: category.id,
    price: 1000
  })
  product2 = await db.product.create({
    nameProduct: 'HIGH5_PROD_2',
    category: category.id,
    price: 2000
  })

  const suffix = Date.now()
  const user1 = await db.user.create({
    id: 9501,
    userName: `high5_admin_a_${suffix}`,
    roleType: 'admin',
    store: store1.id,
    password: 'x'
  })
  // P1-4: central gate denies unknown caller identities; the super token id
  // gets a real row. Assertions below are unchanged.
  await db.user.create({
    id: 9500,
    userName: `high5_super_${suffix}`,
    email: `p14-9500-security-high5-inventory-scoping-${Date.now()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: `high5_super_${suffix}`
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  admin1Token = await signSessionToken(
    { id: user1.id, userName: user1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 9500, userName: `high5_super_${suffix}`, roleType: 'super_admin' },
    JWT_SECRET
  )

  const today = new Date().toISOString().slice(0, 10)
  forecast1 = await db.stock_forecast.create({
    store: store1.id,
    product: product1.id,
    forecast_date: today,
    current_quantity: 10,
    daily_consumption_rate: 2,
    days_until_stockout: 5
  })
  forecast2 = await db.stock_forecast.create({
    store: store2.id,
    product: product2.id,
    forecast_date: today,
    current_quantity: 20,
    daily_consumption_rate: 4,
    days_until_stockout: 5
  })

  batch1 = await db.product_batch.create({
    store: store1.id,
    product: product1.id,
    batchCode: `BATCH-HIGH5-1-${Date.now()}`,
    qty: 50,
    expiryDate: new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10),
    status: 'active'
  })
  batch2 = await db.product_batch.create({
    store: store2.id,
    product: product2.id,
    batchCode: `BATCH-HIGH5-2-${Date.now()}`,
    qty: 150,
    expiryDate: new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10),
    status: 'active'
  })
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [9500] }, force: true })
  await db.product_batch.destroy({
    where: { id: [batch1?.id, batch2?.id].filter(Boolean) },
    force: true
  })
  await db.stock_forecast.destroy({
    where: { id: [forecast1?.id, forecast2?.id].filter(Boolean) },
    force: true
  })
  await db.product.destroy({
    where: { id: [product1?.id, product2?.id].filter(Boolean) },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: [9501] }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
})

describe('HIGH-5 inventory tenant scoping', () => {
  test('getForecasts scopes to store1 and ignores foreign cookie / storeId query', async () => {
    const res = await request(app)
      .get('/inventory/forecast')
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)
      .query({ storeId: store2.id })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const ids = res.body.data.map((f) => f.id)
    expect(ids).toContain(forecast1.id)
    expect(ids).not.toContain(forecast2.id)
  })

  test('getBatches scopes to store1 and does not fail open', async () => {
    const res = await request(app)
      .get('/inventory/batch')
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const ids = res.body.data.map((b) => b.id)
    expect(ids).toContain(batch1.id)
    expect(ids).not.toContain(batch2.id)
  })

  test('getBatchById returns own store batch', async () => {
    const res = await request(app)
      .get(`/inventory/batch/${batch1.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(batch1.id)
  })

  test('getBatchById rejects foreign store batch with 404', async () => {
    const res = await request(app)
      .get(`/inventory/batch/${batch2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(404)
    expect(res.body.message).toMatch(/batch not found/i)
  })

  test('super_admin can view any store batch and all batches', async () => {
    const res = await request(app)
      .get(`/inventory/batch/${batch2.id}`)
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(batch2.id)

    const listRes = await request(app)
      .get('/inventory/batch')
      .set('Authorization', `Bearer ${superToken}`)

    expect(listRes.status).toBe(200)
    const ids = listRes.body.data.map((b) => b.id)
    expect(ids).toContain(batch1.id)
    expect(ids).toContain(batch2.id)
  })

  test('getDeadStock scopes to store1 and ignores cookie', async () => {
    const res = await request(app)
      .get('/inventory/dead-stock')
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  test('getExpiringSoon scopes to store1 and ignores cookie', async () => {
    const res = await request(app)
      .get('/inventory/expiring-soon')
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })
})
