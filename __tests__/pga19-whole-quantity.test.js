'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-19 (product-grade audit 2026-11-02): a counter quantity of 1.5
// reached the integer quantity columns and failed in Postgres with a 500.
// Order lines now take whole units only and say so with a 400.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store
let category
let product
let token

beforeAll(async () => {
  store = await db.location.create({ name: uniq('PGA19_STORE'), status: 'active' })
  category = await db.category.create({ name: uniq('PGA19_CAT') })
  product = await db.product.create({ nameProduct: uniq('PGA19_P'), category: category.id, price: 5000, stock: 100 })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 100 })
  await db.taxConfig.create({ store: store.id, name: uniq('PGA19_PPN'), rate: 0, type: 'ppn', status: 'active' })
  const admin = await db.user.create({
    userName: uniq('pga19_admin'),
    email: `${uniq('pga19_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken({ id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id }, JWT_SECRET)
})

afterAll(async () => {
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.user.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

const post = (path, quantity) =>
  request(app)
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .send(
      withIdempotencyKey({
        store: store.id,
        items: [{ product: product.id, quantity }],
        paymentMethod: 'cash',
        cashAmount: 10000,
        changeAmount: 5000
      })
    )

describe('PGA-19: order quantities are whole units', () => {
  test.each(['/order/create', '/order/quote'])('%s refuses 1.5 with a 400 and writes nothing', async (path) => {
    const before = await db.order.count({ where: { store: store.id } })
    const res = await post(path, 1.5)
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('quantity must be a whole number')
    expect(await db.order.count({ where: { store: store.id } })).toBe(before)
  })

  test('a quantity sent as the string "2" still passes validation', async () => {
    const res = await post('/order/quote', '2')
    expect(res.status).not.toBe(400)
  })
})
