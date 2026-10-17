process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// P1-9: deleting a location must leave a consistent store behind — one
// atomic unit (no partial cascade), no dangling store assignments, shared
// catalog rows (products) untouched, and the unpaid-order lifecycle
// preserved (cancelled, still attributable).

let store = null
let category = null
let product = null
let superToken = null

const auth = (token) => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  store = await db.location.create({ name: `LOCDEL_STORE_${Date.now()}`, status: 'active' })
  category = await db.category.create({ name: `LOCDEL_CAT_${Date.now()}` })
  product = await db.product.create({
    nameProduct: `LOCDEL_PROD_${Date.now()}`,
    category: category.id,
    price: 20000,
    stock: 50,
    inventoryMode: 'stocked'
  })
  await db.product_store.create({ product: product.id, store: store.id })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 50 })
  await db.user.create({
    id: 7991,
    userName: `locdel_super_${Date.now()}`,
    email: `locdel_super_${Date.now()}@test.com`,
    roleType: 'super_admin',
    userType: 'super_admin',
    store: null,
    status: 'active',
    fullName: 'LocDel Super'
  })
  superToken = await signSessionToken(
    { id: 7991, userName: 'locdel_super', roleType: 'super_admin', store: null },
    JWT_SECRET
  )
  // An unpaid order: cancel-safe (no collected money), must survive as a
  // cancelled record of this store.
  await db.order.create({
    orderNumber: `LOCDEL-${Date.now()}`,
    store: store.id,
    status: 'pending',
    paymentStatus: 'unpaid',
    subTotal: 20000,
    totalQuantity: 1,
    totalPrice: 20000,
    paymentMethod: 'cash',
    source: 'pos'
  })
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.order_item.destroy({ where: {}, force: true }).catch(() => {})
  await db.transaction.destroy({ where: {}, force: true }).catch(() => {})
  await db.order_status.destroy({ where: {}, force: true }).catch(() => {})
  await db.order.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.product_store.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.product.destroy({ where: { id: product.id }, force: true }).catch(() => {})
  await db.category.destroy({ where: { id: category.id }, force: true }).catch(() => {})
  await db.user.destroy({ where: { id: [7991] }, force: true }).catch(() => {})
  await db.location.destroy({ where: { id: store.id }, force: true }).catch(() => {})
})

describe('P1-9 — location delete is atomic and leaves no dangling assignments', () => {
  test('unpaid-order store deletes atomically with consistent fallout', async () => {
    const res = await request(app)
      .delete('/location/delete-location')
      .set(auth(superToken))
      .send({ id: `loc-${store.id}` })
    expect(res.status).toBe(200)

    // Location soft-deleted (paranoid), not hard-gone.
    expect(await db.location.findByPk(store.id)).toBeNull()
    const tombstone = await db.location.findByPk(store.id, { paranoid: false })
    expect(tombstone.deletedAt).not.toBeNull()

    // Unpaid order preserved as cancelled history of this store.
    const orders = await db.order.findAll({ where: { store: store.id } })
    expect(orders.length).toBeGreaterThan(0)
    for (const o of orders) {
      expect(['cancelled', 'void']).toContain(o.status)
    }

    // No dangling store assignments or per-store shadows…
    expect(
      await db.product_store.count({ where: { store: store.id } })
    ).toBe(0)
    expect(
      await db.product_store_stock.count({ where: { store: store.id } })
    ).toBe(0)

    // …but the shared catalog product itself survives.
    expect(await db.product.findByPk(product.id)).not.toBeNull()
  })
})
