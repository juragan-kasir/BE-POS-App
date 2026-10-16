process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store = null
let category = null
let token = null
let counter = 0

const nextTag = () => {
  counter += 1
  return `PSS-${Date.now()}-${counter}`
}

beforeAll(async () => {
  store = await db.location.create({ name: 'PSS_STORE', status: 'active' })
  category = await db.category.create({ name: 'PSS_CATEGORY' })
  await db.user.create({
    id: 9404,
    userName: 'pss_admin',
    email: 'p14-9404-pss-first-sale@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'pss_admin'
  })
  token = await signSessionToken(
    { id: 9404, userName: 'pss_admin', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  await db.cashRegister.destroy({ where: { store: store.id, status: 'open' }, force: true })
  await db.cashRegister.create({
    store: store.id,
    user: 9404,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
  await db.taxConfig.create({
    name: `PSS_PPN_${store.id}`,
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
})

afterAll(async () => {
  const orderIds = await db.order
    .findAll({ where: { store: store.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  await db.taxConfig.destroy({
    where: { store: store.id },
    force: true
  })
  // Scoped cleanup only (never a global wipe): parallel suites share this
  // test database, and an unscoped destroy can delete another suite's
  // ledger rows mid-flight.
  if (orderIds.length) {
    await db.stock_history.destroy({ where: { referenceId: orderIds }, force: true })
    await db.order_item.destroy({ where: { order: orderIds }, force: true })
    await db.transaction.destroy({ where: { order: orderIds }, force: true })
    await db.order_status.destroy({ where: { order: orderIds }, force: true })
  }
  await db.order.destroy({ where: { store: store.id }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.user.destroy({ where: { id: [9404] }, force: true })
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.best_selling.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { category: category.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

describe('product_store_stock first-sale seeding', () => {
  test('first sale at a store without a shadow row mirrors the global stock', async () => {
    const product = await db.product.create({
      nameProduct: nextTag(),
      category: category.id,
      price: 20000,
      stock: 100,
      inventoryMode: 'stocked'
    })
    // Precondition: no per-store shadow row exists yet (e.g. product
    // assigned to this store after creation).
    const before = await db.product_store_stock.findOne({
      where: { product: product.id, store: store.id }
    })
    expect(before).toBeNull()

    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${token}`)
      .send(withIdempotencyKey({
        store: store.id,
        items: [{ product: product.id, quantity: 5 }],
        paymentMethod: 'cash',
        cashierName: 'PSS Test'
      }))
    expect(res.status).toBe(201)

    const afterProduct = await db.product.findByPk(product.id)
    expect(Number(afterProduct.stock)).toBe(95)
    const shadow = await db.product_store_stock.findOne({
      where: { product: product.id, store: store.id }
    })
    expect(shadow).not.toBeNull()
    // The shadow must track the same deduction, not stay clamped at 0.
    expect(Number(shadow.stock)).toBe(95)
  })
})
