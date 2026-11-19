process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 11 — BATCH10-02 remediation.
//
// cancelTransfer() (api/controller/pos.js) had the same shape of defect
// Batch 10 fixed in receiveTransfer(): `transfer.status !== 'sent'` was
// checked against a plain, unlocked findOne() read taken BEFORE the
// mutation transaction opened, with no re-validation or lock on the
// stock_transfer header row inside the transaction. Two concurrent
// PUT /pos/transfer/:id/cancel calls for the SAME transfer could both
// pass the stale guard and both reverse the stock — double-crediting the
// source store. Proven here with two real concurrent HTTP requests
// against a real Postgres transaction (no mocks, no fake timers).

let storeA = null
let storeB = null
let category = null
let product = null
let superAdminUser = null
let superAdminToken = null
let transferId = null

const STARTING_STOCK = 50
const TRANSFER_QTY = 10

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'STC_RACE_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'STC_RACE_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'STC_RACE_CATEGORY' })

  product = await db.product.create({
    nameProduct: 'STC_RACE_PRODUCT',
    category: category.id,
    price: 5000,
    stock: STARTING_STOCK
  })
  await db.product_store_stock.create({
    product: product.id,
    store: storeA.id,
    stock: STARTING_STOCK
  })

  superAdminUser = await db.user.create({
    userName: 'superadmin_stc_race',
    email: 'superadmin_stc_race@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active'
  })
  superAdminToken = await signSessionToken(
    { id: superAdminUser.id, userName: superAdminUser.userName, roleType: 'super_admin' },
    JWT_SECRET
  )

  const createRes = await request(app)
    .post('/pos/transfer')
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({
      fromStore: storeA.id,
      toStore: storeB.id,
      items: [{ productId: product.id, qty: TRANSFER_QTY }]
    })
  expect(createRes.status).toBe(201)
  expect(createRes.body.data.status).toBe('sent')
  transferId = createRes.body.data.id

  const sourceAfterCreate = await db.product_store_stock.findOne({
    where: { product: product.id, store: storeA.id }
  })
  expect(Number(sourceAfterCreate.stock)).toBe(STARTING_STOCK - TRANSFER_QTY)
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { product: product.id }, force: true })
  await db.stock_transfer_item.destroy({ where: { stockTransfer: transferId }, force: true })
  await db.stock_transfer.destroy({ where: { id: transferId }, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: superAdminUser?.id }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id] }, force: true })
})

describe('PUT /pos/transfer/:id/cancel — duplicate/concurrent cancel must not double-credit source stock', () => {
  test('two concurrent cancel requests for the same transfer credit source stock exactly once', async () => {
    const [resA, resB] = await Promise.all([
      request(app)
        .put(`/pos/transfer/${transferId}/cancel`)
        .set('Authorization', `Bearer ${superAdminToken}`),
      request(app)
        .put(`/pos/transfer/${transferId}/cancel`)
        .set('Authorization', `Bearer ${superAdminToken}`)
    ])

    // Whatever the two HTTP outcomes are, the source store must have been
    // credited back exactly once — not twice.
    const sourceStock = await db.product_store_stock.findOne({
      where: { product: product.id, store: storeA.id }
    })
    expect(Number(sourceStock?.stock) || 0).toBe(STARTING_STOCK)

    const baseProduct = await db.product.findByPk(product.id)
    expect(Number(baseProduct.stock)).toBe(STARTING_STOCK)

    const cancelHistory = await db.stock_history.findAll({
      where: { referenceType: 'transfer', referenceId: transferId, store: storeA.id }
    })
    // One entry from the initial send (decrement) + one from a single
    // valid cancel (increment) — never a second cancel-increment entry.
    expect(cancelHistory.length).toBe(2)
    const cancelEntries = cancelHistory.filter((h) => Number(h.quantityChange) > 0)
    expect(cancelEntries.length).toBe(1)

    const finalTransfer = await db.stock_transfer.findByPk(transferId)
    expect(finalTransfer.status).toBe('cancelled')

    const statuses = [resA.status, resB.status].sort()
    expect(statuses).toEqual([200, 400])
  })
})
