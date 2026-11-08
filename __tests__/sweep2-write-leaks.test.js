'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Tenant sweep stage 2 (2026-11-08): two body-id write leaks.
//  - POST /delivery/orders accepted any `order` id, so a tenant-A admin could
//    attach a delivery to a tenant-B order.
//  - PUT /pos/product/update-price-by-store checked the target outlets but
//    not the product, so a tenant-A caller could write an outlet price row
//    for a tenant-B product.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const unique = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const tenants = []
const stores = []
const products = []
const orders = []
let category
let admin
let token
let storeA
let storeB

const product = async (store) => {
  const p = await db.product.create({
    nameProduct: unique('SW2_PROD'),
    category: category.id,
    price: 10000,
    status: 'active'
  })
  await db.product_store.create({ product: p.id, store: store.id })
  products.push(p)
  return p
}

const order = async (store) => {
  const o = await db.order.create({
    orderNumber: unique('SW2'),
    store: store.id,
    status: 'pending'
  })
  orders.push(o)
  return o
}

const deliver = (body) =>
  request(app)
    .post('/delivery/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: storeA.id,
      customerName: 'Budi',
      deliveryAddress: 'Jl. Mawar 1',
      ...body
    })

const price = (productId) =>
  request(app)
    .put('/pos/product/update-price-by-store')
    .set('Authorization', `Bearer ${token}`)
    .send({ productId, storePrices: [{ storeId: storeA.id, price: 12000 }] })

beforeAll(async () => {
  for (const tag of ['A', 'B']) {
    const t = await db.tenant.create({
      code: unique(`SW2${tag}`).toUpperCase().slice(0, 30),
      name: unique(`SW2${tag}`)
    })
    tenants.push(t)
    stores.push(
      await db.location.create({
        name: unique(`SW2_STORE_${tag}`),
        status: 'active',
        tenantId: t.id
      })
    )
  }
  ;[storeA, storeB] = stores
  category = await db.category.create({ name: unique('SW2_CAT') })
  admin = await db.user.create({
    userName: unique('sw2_admin'),
    email: `${unique('sw2_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active'
  })
  token = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  const productIds = products.map((p) => p.id)
  const storeIds = stores.map((s) => s.id)
  const deliveries = await db.delivery_order.findAll({
    where: { store: storeIds },
    attributes: ['id']
  })
  await db.delivery_status_history.destroy({
    where: { deliveryOrder: deliveries.map((d) => d.id) },
    force: true
  })
  await db.delivery_order.destroy({ where: { store: storeIds }, force: true })
  await db.order.destroy({ where: { id: orders.map((o) => o.id) }, force: true })
  await db.product_store_price.destroy({ where: { product: productIds }, force: true })
  await db.product_store.destroy({ where: { product: productIds }, force: true })
  await db.product.destroy({ where: { id: productIds }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.audit_log?.destroy({ where: { userId: admin?.id } }).catch(() => {})
  await db.authorizationContextSession.destroy({ where: { userId: admin?.id } })
  await db.user.destroy({ where: { id: admin?.id }, force: true })
  await db.location.destroy({ where: { id: storeIds }, force: true })
  await db.tenant.destroy({ where: { id: tenants.map((t) => t.id) }, force: true })
})

describe('POST /delivery/orders links only orders of the caller', () => {
  test("another tenant's order is not found and nothing is written", async () => {
    const foreign = await order(storeB)
    const res = await deliver({ order: foreign.id })
    expect(res.status).toBe(404)
    expect(await db.delivery_order.count({ where: { order: foreign.id } })).toBe(0)
  })

  test('an own order from a different store than the delivery is refused', async () => {
    const storeA2 = await db.location.create({
      name: unique('SW2_STORE_A2'),
      status: 'active',
      tenantId: tenants[0].id
    })
    stores.push(storeA2)
    const own = await order(storeA2)
    const res = await deliver({ order: own.id })
    expect(res.status).toBe(404)
  })

  test('an own order, or no order, still creates the delivery', async () => {
    const own = await order(storeA)
    expect((await deliver({ order: own.id })).status).toBe(201)
    expect((await deliver({})).status).toBe(201)
  })
})

describe('PUT /pos/product/update-price-by-store prices only own products', () => {
  test("another tenant's product is not found and no price row is written", async () => {
    const foreign = await product(storeB)
    const res = await price(foreign.id)
    expect(res.status).toBe(404)
    expect(
      await db.product_store_price.count({ where: { product: foreign.id } })
    ).toBe(0)
  })

  test('an own product is still priced', async () => {
    const own = await product(storeA)
    const res = await price(own.id)
    expect(res.status).toBe(200)
    const row = await db.product_store_price.findOne({
      where: { product: own.id, store: storeA.id }
    })
    expect(Number(row?.price)).toBe(12000)
  })
})
