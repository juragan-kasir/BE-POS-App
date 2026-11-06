'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-17 (owner decision 2026-11-07: mode per outlet). A product sold at two
// outlets with a recipe at only one stayed 'stocked' everywhere (the
// adoption waits for every outlet), so the recipe outlet refused every sale
// as INSUFFICIENT_STOCK. The mode is now decided per outlet: the outlet with
// an active recipe sells by recipe, the other keeps selling its own stock.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const unique = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let tenant
let storeA
let storeB
let category
let susu
let kopiSusu
let bom
const users = []
const tokens = {}

const outletStock = async (product, store) =>
  Number(
    (
      await db.product_store_stock.findOne({
        where: { product: product.id, store: store.id }
      })
    ).stock
  )

const sell = (who, store, quantity) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send({
      store: store.id,
      items: [{ product: kopiSusu.id, quantity }],
      paymentMethod: 'cash',
      cashAmount: 20000 * quantity,
      changeAmount: 0,
      idempotencyKey: unique('pga17')
    })

beforeAll(async () => {
  tenant = await db.tenant.create({
    code: unique('T').toUpperCase().slice(0, 30),
    name: unique('PGA17')
  })
  storeA = await db.location.create({
    name: unique('PGA17_A'),
    status: 'active',
    tenantId: tenant.id
  })
  storeB = await db.location.create({
    name: unique('PGA17_B'),
    status: 'active',
    tenantId: tenant.id
  })
  category = await db.category.create({ name: unique('PGA17_CAT') })
  for (const s of [storeA, storeB]) {
    await db.taxConfig.create({
      store: s.id,
      name: unique('PPN'),
      rate: 0,
      type: 'ppn',
      status: 'active'
    })
  }
  for (const [key, s] of [
    ['a', storeA],
    ['b', storeB]
  ]) {
    const u = await db.user.create({
      userName: unique(`pga17_${key}`),
      email: `${unique(`pga17_${key}`)}@test.com`,
      roleType: 'admin',
      userType: 'admin',
      store: s.id,
      status: 'active'
    })
    users.push(u.id)
    tokens[key] = await signSessionToken(
      { id: u.id, userName: u.userName, roleType: 'admin', store: s.id },
      JWT_SECRET
    )
    const open = await request(app)
      .post('/cash-register/open')
      .set('Authorization', `Bearer ${tokens[key]}`)
      .send({ store: s.id, openingBalance: 0 })
    if (![200, 201].includes(open.status))
      throw new Error('register setup failed: ' + JSON.stringify(open.body))
  }

  // Sold at both outlets, 'stocked', no stock at A, 5 at B.
  kopiSusu = await db.product.create({
    nameProduct: unique('KOPI_SUSU'),
    category: category.id,
    price: 20000,
    costPrice: 0,
    inventoryMode: 'stocked',
    stock: 5,
    status: 'active'
  })
  await db.product_store.create({ product: kopiSusu.id, store: storeA.id })
  await db.product_store.create({ product: kopiSusu.id, store: storeB.id })
  await db.product_store_stock.create({
    product: kopiSusu.id,
    store: storeA.id,
    stock: 0
  })
  await db.product_store_stock.create({
    product: kopiSusu.id,
    store: storeB.id,
    stock: 5
  })

  // A recipe at outlet A only: 100 ml milk a cup.
  susu = await db.ingredient.create({
    store: storeA.id,
    name: unique('SUSU'),
    stock: 1000,
    minStock: 0,
    unit: 'ml',
    baseUnit: 'ml',
    conversionFactor: 1,
    costPrice: 10,
    status: 'active'
  })
  bom = await db.bom_header.create({
    store: storeA.id,
    productId: kopiSusu.id,
    name: 'r',
    totalQty: 1,
    status: 'active'
  })
  await db.bom_line.create({
    bomHeaderId: bom.id,
    ingredientId: susu.id,
    qty: 100,
    unit: 'ml'
  })
})

afterAll(async () => {
  const stores = [storeA?.id, storeB?.id].filter(Boolean)
  const orderIds = (
    await db.order.findAll({ where: { store: stores }, attributes: ['id'] })
  ).map((o) => o.id)
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.stock_history.destroy({ where: { store: stores }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.cashRegister.destroy({ where: { store: stores }, force: true })
  await db.bom_line.destroy({ where: { bomHeaderId: bom?.id }, force: true })
  await db.bom_header.destroy({ where: { id: bom?.id }, force: true })
  await db.best_selling
    .destroy({ where: { productId: kopiSusu?.id }, force: true })
    .catch(() => {})
  await db.product_store_stock.destroy({
    where: { product: kopiSusu?.id },
    force: true
  })
  await db.product_store.destroy({
    where: { product: kopiSusu?.id },
    force: true
  })
  await db.product.destroy({ where: { id: kopiSusu?.id }, force: true })
  await db.ingredient.destroy({ where: { id: susu?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: stores }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: users } })
  await db.user.destroy({ where: { id: users }, force: true })
  await db.location.destroy({ where: { id: stores }, force: true })
  await db.tenant.destroy({ where: { id: tenant?.id }, force: true })
})

describe('PGA-17: the inventory mode is decided per outlet', () => {
  test('the outlet with a recipe sells by recipe: ingredients go down, its finished-good stock is untouched', async () => {
    const res = await sell('a', storeA, 2)
    expect(res.status).toBe(201)
    await susu.reload()
    expect(Number(susu.stock)).toBe(800)
    expect(await outletStock(kopiSusu, storeA)).toBe(0)
  })

  test('the outlet without a recipe keeps selling its own stock and uses no ingredient', async () => {
    const res = await sell('b', storeB, 1)
    expect(res.status).toBe(201)
    expect(await outletStock(kopiSusu, storeB)).toBe(4)
    await susu.reload()
    expect(Number(susu.stock)).toBe(800)
  })

  test('the stored product mode is not changed', async () => {
    await kopiSusu.reload()
    expect(kopiSusu.inventoryMode).toBe('stocked')
  })

  test('recipe availability lists the product at the recipe outlet only', async () => {
    const a = await request(app)
      .get('/product/recipe-availability')
      .set('Authorization', `Bearer ${tokens.a}`)
    const b = await request(app)
      .get('/product/recipe-availability')
      .set('Authorization', `Bearer ${tokens.b}`)
    expect(a.status).toBe(200)
    expect(
      a.body.data.products.find((r) => r.productId === kopiSusu.id)
    ).toMatchObject({ portions: 8 })
    expect(
      b.body.data.products.find((r) => r.productId === kopiSusu.id)
    ).toBeUndefined()
  })

  test('the cashier catalog reports the mode of its own outlet', async () => {
    const pick = async (who) => {
      const res = await request(app)
        .get('/product/get-product-by-super-admin?limit=500')
        .set('Authorization', `Bearer ${tokens[who]}`)
      expect(res.status).toBe(200)
      return res.body.data.find((p) => p.id === kopiSusu.id)
    }
    expect((await pick('a')).inventoryMode).toBe('make_to_order')
    expect((await pick('b')).inventoryMode).toBe('stocked')
  })

  test('a recipe outlet still refuses what its ingredients cannot make', async () => {
    const res = await sell('a', storeA, 9) // 900 ml needed, 800 left
    expect(res.status).toBe(409)
    await susu.reload()
    expect(Number(susu.stock)).toBe(800)
  })
})
