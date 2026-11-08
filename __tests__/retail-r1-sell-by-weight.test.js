'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Retail R1 (owner decision 2026-11-08): sell by weight. A product flagged
// allowDecimalQty sells in fractions (three decimals); the line total is the
// unit price × quantity rounded to the nearest Rp1, half up; outlet stock
// moves by the exact quantity. Every other product still sells whole units.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { lineTotal, roundQty, isSellableQuantity } = require('../utils/quantity')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const unique = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let tenant
let store
let category
let weighed
let unit
let admin
let token

const sell = (items) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      items,
      paymentMethod: 'e-wallet',
      referenceNumber: unique('WREF'),
      idempotencyKey: unique('w')
    })

const outletStock = async (productId) =>
  Number(
    (await db.product_store_stock.findOne({ where: { product: productId, store: store.id } }))
      .stock
  )

const lines = async (orderId) =>
  db.order_item.findAll({ where: { order: orderId }, order: [['id', 'ASC']] })

beforeAll(async () => {
  tenant = await db.tenant.create({
    code: unique('W').toUpperCase().slice(0, 30),
    name: unique('W')
  })
  store = await db.location.create({
    name: unique('W_STORE'),
    status: 'active',
    tenantId: tenant.id
  })
  category = await db.category.create({ name: unique('W_CAT') })
  await db.taxConfig.create({
    store: store.id,
    name: unique('PPN'),
    rate: 0,
    type: 'ppn',
    status: 'active'
  })
  admin = await db.user.create({
    userName: unique('w_admin'),
    email: `${unique('w_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  const product = async (name, price, extra = {}) => {
    const p = await db.product.create({
      nameProduct: unique(name),
      category: category.id,
      price,
      costPrice: Math.round(price / 2),
      inventoryMode: 'stocked',
      stock: 10,
      status: 'active',
      ...extra
    })
    await db.product_store.create({ product: p.id, store: store.id })
    await db.product_store_stock.create({ product: p.id, store: store.id, stock: 10 })
    return p
  }
  weighed = await product('DAGING_SAPI', 12345, {
    allowDecimalQty: true,
    unit: 'kg',
    priceTiers: [{ id: 'g5', name: 'Grosir 5 kg', price: 11000, minQty: 5 }]
  })
  unit = await product('SABUN', 5000)
  const open = await request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${token}`)
    .send({ store: store.id, openingBalance: 0 })
  if (![200, 201].includes(open.status))
    throw new Error('register setup failed: ' + JSON.stringify(open.body))
})

afterAll(async () => {
  const productIds = [weighed?.id, unit?.id].filter(Boolean)
  const orderIds = (
    await db.order.findAll({ where: { store: store.id }, attributes: ['id'], paranoid: false })
  ).map((o) => o.id)
  const quiet = (p) => Promise.resolve(p).catch(() => {})
  const returns = await db.sales_return.findAll({ where: { order: orderIds }, attributes: ['id'] }).catch(() => [])
  await quiet(db.sales_return_item.destroy({ where: { salesReturn: returns.map((r) => r.id) }, force: true }))
  await quiet(db.sales_return.destroy({ where: { order: orderIds }, force: true }))
  await quiet(db.transaction.destroy({ where: { order: orderIds }, force: true }))
  await quiet(db.order_item.destroy({ where: { order: orderIds }, force: true }))
  await quiet(db.order_status.destroy({ where: { order: orderIds }, force: true }))
  await quiet(db.stock_history.destroy({ where: { store: store.id }, force: true }))
  await quiet(db.order.destroy({ where: { id: orderIds }, force: true }))
  await quiet(db.cashRegister.destroy({ where: { store: store.id }, force: true }))
  await quiet(db.best_selling.destroy({ where: { productId: productIds }, force: true }))
  await quiet(db.product_store_stock.destroy({ where: { product: productIds }, force: true }))
  await quiet(db.product_store.destroy({ where: { product: productIds }, force: true }))
  await quiet(db.product.destroy({ where: { id: productIds }, force: true }))
  await quiet(db.taxConfig.destroy({ where: { store: store.id }, force: true }))
  await quiet(db.category.destroy({ where: { id: category?.id }, force: true }))
  await quiet(db.authorizationContextSession.destroy({ where: { userId: admin?.id } }))
  await quiet(db.user.destroy({ where: { id: admin?.id }, force: true }))
  await quiet(db.location.destroy({ where: { id: store?.id }, force: true }))
  await quiet(db.tenant.destroy({ where: { id: tenant?.id }, force: true }))
})

describe('quantity helpers', () => {
  test('line total rounds to the nearest Rp1, half up, without float drift', () => {
    expect(lineTotal(12345, 0.5)).toBe(6173) // 6172.5
    expect(lineTotal(1000, 1.005)).toBe(1005)
    expect(lineTotal(200, 2.675)).toBe(535)
    expect(lineTotal(9999, 3)).toBe(29997)
    expect(lineTotal(333, 0.001)).toBe(0) // 0.333
    expect(lineTotal(500, 0.001)).toBe(1) // 0.5 rounds up
  })

  test('quantities keep three decimals and fractions need the product flag', () => {
    expect(roundQty(0.1 + 0.2)).toBe(0.3)
    expect(isSellableQuantity({ allowDecimalQty: false }, 2)).toBe(true)
    expect(isSellableQuantity({ allowDecimalQty: false }, 1.5)).toBe(false)
    expect(isSellableQuantity({ allowDecimalQty: true }, 1.255)).toBe(true)
    expect(isSellableQuantity({ allowDecimalQty: true }, 1.2555)).toBe(false)
    expect(isSellableQuantity({ allowDecimalQty: true }, 0)).toBe(false)
  })
})

describe('Retail R1: sell by weight', () => {
  test('a weighed product sells a fraction; total rounds and stock moves exactly', async () => {
    const before = await outletStock(weighed.id)
    const res = await sell([{ product: weighed.id, quantity: 0.5 }])
    expect(res.status).toBe(201)
    const [line] = await lines(res.body.data.id)
    expect(line.quantity).toBe(0.5)
    expect(Number(line.totalPrice)).toBe(6173)
    const order = await db.order.findByPk(res.body.data.id)
    expect(order.totalQuantity).toBe(0.5)
    expect(Number(order.subTotal)).toBe(6173)
    expect(await outletStock(weighed.id)).toBeCloseTo(before - 0.5, 4)
  })

  test('gram precision is kept and the grosir break applies by weight', async () => {
    const res = await sell([{ product: weighed.id, quantity: 5.255 }])
    expect(res.status).toBe(201)
    const [line] = await lines(res.body.data.id)
    expect(line.quantity).toBe(5.255)
    expect(Number(line.price)).toBe(11000)
    expect(Number(line.totalPrice)).toBe(57805)
  })

  test('a whole-unit product refuses a fraction', async () => {
    const res = await sell([{ product: unit.id, quantity: 1.5 }])
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('QUANTITY_NOT_DIVISIBLE')
    expect((await sell([{ product: unit.id, quantity: 2 }])).status).toBe(201)
  })

  test('more than three decimals is a validation error', async () => {
    const res = await sell([{ product: weighed.id, quantity: 1.2345 }])
    expect([400, 422]).toContain(res.status)
  })

  test('selling more than the outlet holds is refused', async () => {
    const stock = await outletStock(weighed.id)
    const res = await sell([{ product: weighed.id, quantity: roundQty(stock + 0.001) }])
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INSUFFICIENT_STOCK')
  })

  test('a weighed line can be partly returned by weight', async () => {
    const sale = await sell([{ product: weighed.id, quantity: 2 }])
    expect(sale.status).toBe(201)
    const [line] = await lines(sale.body.data.id)
    const res = await request(app)
      .post(`/pos/order/${sale.body.data.id}/return`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: weighed.id, orderItemId: line.id, qty: 0.25 }],
        reason: 'Kelebihan timbang',
        idempotencyKey: unique('ret')
      })
    expect(res.status).toBe(201)
    const item = await db.sales_return_item.findOne({ where: { orderItem: line.id } })
    expect(item.qty).toBe(0.25)
  })

  test('a whole-unit line cannot be returned in fractions', async () => {
    const sale = await sell([{ product: unit.id, quantity: 2 }])
    const [line] = await lines(sale.body.data.id)
    const res = await request(app)
      .post(`/pos/order/${sale.body.data.id}/return`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: unit.id, orderItemId: line.id, qty: 0.5 }],
        reason: 'Salah',
        idempotencyKey: unique('ret')
      })
    expect(res.status).toBe(422)
  })
})
