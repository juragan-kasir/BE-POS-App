'use strict'

process.env.NODE_ENV = 'test'

// Retail R1: the public customer menu publishes each product's grosir
// breaks (tiers with minQty) so the QR app can show and echo the price a
// larger quantity pays. Named tiers (member prices) are never published.
const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')
const { quantityBreaksOf } = require('../utils/outletPricing')

const unique = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store
let category
let product

beforeAll(async () => {
  store = await db.location.create({ name: unique('QB_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('QB_CAT') })
  product = await db.product.create({
    nameProduct: unique('QB_GULA'),
    category: category.id,
    price: 10000,
    stock: 100,
    status: 'active',
    isAvailable: true,
    priceTiers: [
      { id: 'b', name: 'Grosir 48', price: 8500, minQty: 48 },
      { id: 'a', name: 'Grosir 12', price: 9000, minQty: 12 },
      { id: 'm', name: 'Harga Member', price: 9500 }
    ]
  })
  await db.product_store.create({ product: product.id, store: store.id })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 100 })
})

afterAll(async () => {
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product_store.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

test('the menu lists grosir breaks sorted, without named tiers or the raw tiers', async () => {
  const res = await request(app).get('/order/customer-menu').query({ store: store.id })
  expect(res.status).toBe(200)
  const products = res.body.data?.products || res.body.products || res.body.data || []
  const row = products.find((p) => p.id === product.id)
  expect(row).toBeDefined()
  expect(row.quantityBreaks).toEqual([
    { minQty: 12, price: 9000 },
    { minQty: 48, price: 8500 }
  ])
  expect(row.priceTiers).toBeUndefined()
  expect(JSON.stringify(row)).not.toContain('Harga Member')
})

test('quantityBreaksOf ignores tiers the server never applies', () => {
  expect(quantityBreaksOf(null)).toEqual([])
  expect(
    quantityBreaksOf([{ price: 1 }, { minQty: 0, price: 2 }, { minQty: 3, price: 4.6 }])
  ).toEqual([{ minQty: 3, price: 5 }])
})
