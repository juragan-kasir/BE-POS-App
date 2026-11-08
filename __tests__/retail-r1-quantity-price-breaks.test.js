'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Retail R1 (owner decision 2026-11-08): quantity price breaks (grosir). A
// priceTiers entry with `minQty` sets the unit price for a line of at least
// that many units; the highest qualifying minQty wins; tiers without minQty
// (named price lists) are never applied automatically. Decided on the
// server only — the client never picks the price.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { normalizePriceTiers } = require('../utils/outletPricing')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const unique = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let tenant
let store
let category
let product
let admin
let token

const TIERS = [
  { id: 't1', name: 'Grosir 12', price: 9000, minQty: 12 },
  { id: 't2', name: 'Grosir 48', price: 8500, minQty: 48 },
  { id: 't3', name: 'Harga Member', price: 9500 }
]

const sell = (items) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      items,
      paymentMethod: 'e-wallet',
      referenceNumber: unique('R1REF'),
      idempotencyKey: unique('r1')
    })

const linePrice = async (res) => {
  expect(res.status).toBe(201)
  const items = await db.order_item.findAll({
    where: { order: res.body.data.id },
    order: [['id', 'ASC']]
  })
  return items.map((i) => Number(i.price))
}

beforeAll(async () => {
  tenant = await db.tenant.create({
    code: unique('R1').toUpperCase().slice(0, 30),
    name: unique('R1')
  })
  store = await db.location.create({
    name: unique('R1_STORE'),
    status: 'active',
    tenantId: tenant.id
  })
  category = await db.category.create({ name: unique('R1_CAT') })
  await db.taxConfig.create({
    store: store.id,
    name: unique('PPN'),
    rate: 0,
    type: 'ppn',
    status: 'active'
  })
  admin = await db.user.create({
    userName: unique('r1_admin'),
    email: `${unique('r1_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken(
    {
      id: admin.id,
      userName: admin.userName,
      roleType: 'admin',
      store: store.id
    },
    JWT_SECRET
  )
  product = await db.product.create({
    nameProduct: unique('GULA_1KG'),
    category: category.id,
    price: 10000,
    costPrice: 7000,
    inventoryMode: 'stocked',
    stock: 1000,
    status: 'active',
    priceTiers: TIERS,
    options: [{ name: 'Kemasan', options: [{ name: 'Plastik', price: 500 }] }]
  })
  await db.product_store.create({ product: product.id, store: store.id })
  await db.product_store_stock.create({
    product: product.id,
    store: store.id,
    stock: 1000
  })
  const open = await request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${token}`)
    .send({ store: store.id, openingBalance: 0 })
  if (![200, 201].includes(open.status))
    throw new Error('register setup failed: ' + JSON.stringify(open.body))
})

afterAll(async () => {
  const orderIds = (
    await db.order.findAll({ where: { store: store.id }, attributes: ['id'] })
  ).map((o) => o.id)
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.product_store_price.destroy({
    where: { product: product?.id },
    force: true
  })
  await db.best_selling
    .destroy({ where: { productId: product?.id }, force: true })
    .catch(() => {})
  await db.product_store_stock.destroy({
    where: { product: product?.id },
    force: true
  })
  await db.product_store.destroy({
    where: { product: product?.id },
    force: true
  })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: admin?.id } })
  await db.user.destroy({ where: { id: admin?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
  await db.tenant.destroy({ where: { id: tenant?.id }, force: true })
})

describe('Retail R1: quantity price breaks', () => {
  test('below the first break the catalog price applies', async () => {
    expect(
      await linePrice(await sell([{ product: product.id, quantity: 11 }]))
    ).toEqual([10000])
  })

  test('at a break its price applies, and the highest qualifying break wins', async () => {
    expect(
      await linePrice(await sell([{ product: product.id, quantity: 12 }]))
    ).toEqual([9000])
    expect(
      await linePrice(await sell([{ product: product.id, quantity: 50 }]))
    ).toEqual([8500])
  })

  test('a named tier without minQty is never applied automatically', async () => {
    expect(
      await linePrice(await sell([{ product: product.id, quantity: 1 }]))
    ).toEqual([10000])
  })

  test('option markup applies on top of the break price', async () => {
    expect(
      await linePrice(
        await sell([
          { product: product.id, quantity: 12, options: [{ name: 'Plastik' }] }
        ])
      )
    ).toEqual([9500])
  })

  test('a break replaces the outlet price too', async () => {
    await db.product_store_price.create({
      product: product.id,
      store: store.id,
      price: 11000
    })
    expect(
      await linePrice(await sell([{ product: product.id, quantity: 2 }]))
    ).toEqual([11000])
    expect(
      await linePrice(await sell([{ product: product.id, quantity: 12 }]))
    ).toEqual([9000])
    await db.product_store_price.destroy({
      where: { product: product.id, store: store.id },
      force: true
    })
  })

  test('the client cannot keep the catalog price at a break: an echoed catalog price is a mismatch', async () => {
    const res = await sell([
      { product: product.id, quantity: 12, expectedPrice: 10000 }
    ])
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PRICE_CHANGED')
    expect(res.body.items?.[0]?.currentPrice).toBe(9000)
  })
})

describe('normalizePriceTiers', () => {
  test('keeps a positive minQty, drops an invalid one, and rounds prices', () => {
    expect(
      normalizePriceTiers([
        { name: 'A', price: '9000.4', minQty: '12' },
        { name: 'B', price: 9500, minQty: 0 },
        null
      ])
    ).toEqual([
      { name: 'A', price: 9000, minQty: 12 },
      { name: 'B', price: 9500 }
    ])
  })
})
