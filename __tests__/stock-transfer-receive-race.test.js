process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 10 — warehouse stock mutation audit.
//
// receiveTransfer() (api/controller/pos.js) reads `transfer.status` with a
// plain, unlocked findOne() BEFORE opening the mutation transaction, and
// only re-checks status via `if (transfer.status !== 'sent')` against that
// stale, pre-transaction read. The actual stock increment + status flip to
// 'received' happen afterward inside the transaction, but nothing re-reads
// or locks the stock_transfer header row at that point to confirm it is
// still 'sent'. Two concurrent PUT /pos/transfer/:id/receive calls for the
// SAME transfer can therefore both pass the stale guard and both credit
// destination stock — a duplicate-mutation / lost-update defect (Phase 9 /
// Phase 10's exact "duplicate mutation double-applies" category), proven
// here with two real concurrent HTTP requests against a real Postgres
// transaction (no mocks, no fake timers).

let storeA = null
let storeB = null
let category = null
let product = null
let superAdminUser = null
let superAdminToken = null
let transferId = null

const TRANSFER_QTY = 10

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'STR_RACE_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'STR_RACE_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'STR_RACE_CATEGORY' })

  product = await db.product.create({
    nameProduct: 'STR_RACE_PRODUCT',
    category: category.id,
    price: 5000,
    stock: 50
  })
  await db.product_store_stock.create({
    product: product.id,
    store: storeA.id,
    stock: 50
  })

  superAdminUser = await db.user.create({
    userName: 'superadmin_str_race',
    email: 'superadmin_str_race@test.com',
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

describe('PUT /pos/transfer/:id/receive — duplicate/concurrent receive must not double-credit stock', () => {
  test('two concurrent receive requests for the same transfer credit destination stock exactly once', async () => {
    const [resA, resB] = await Promise.all([
      request(app)
        .put(`/pos/transfer/${transferId}/receive`)
        .set('Authorization', `Bearer ${superAdminToken}`),
      request(app)
        .put(`/pos/transfer/${transferId}/receive`)
        .set('Authorization', `Bearer ${superAdminToken}`)
    ])

    // Whatever the two HTTP outcomes are, the destination store must have
    // received the transferred quantity exactly once — not twice.
    const destStock = await db.product_store_stock.findOne({
      where: { product: product.id, store: storeB.id }
    })
    expect(Number(destStock?.stock) || 0).toBe(TRANSFER_QTY)

    const baseProduct = await db.product.findByPk(product.id)
    // Source deducted 10 from 50 at creation; a correct single receive
    // does not touch product.stock's total further (receive only credits
    // the destination's product_store_stock/base stock by +qty once).
    expect(Number(baseProduct.stock)).toBe(40 + TRANSFER_QTY)

    const receivedHistory = await db.stock_history.findAll({
      where: { referenceType: 'transfer', referenceId: transferId, store: storeB.id }
    })
    expect(receivedHistory.length).toBe(1)

    const statuses = [resA.status, resB.status].sort()
    expect(statuses).toEqual([200, 400])
  })
})
