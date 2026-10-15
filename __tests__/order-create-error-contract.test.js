process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Pass-through mocks so single calls can be made to fail deterministically
// (one pre-commit infrastructure error, one post-commit side effect).
jest.mock('../api/service/settlementAttribution', () => {
  const actual = jest.requireActual('../api/service/settlementAttribution')
  return { ...actual, resolveAttributedRegister: jest.fn(actual.resolveAttributedRegister) }
})
jest.mock('../api/service/socket', () => {
  const actual = jest.requireActual('../api/service/socket')
  return { ...actual, emitNewOrder: jest.fn(actual.emitNewOrder) }
})

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { resolveAttributedRegister } = require('../api/service/settlementAttribution')
const { emitNewOrder } = require('../api/service/socket')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Stable machine-readable outcomes on the counter-sale and settlement paths
// (DR-23 §M refusal names; codes are additive — messages and HTTP statuses
// are unchanged), TOTAL_CHANGED (DR-17 via DR-23 §M), no internal error
// text in 500s, and a committed sale never reported as failed.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const PRICE = 10000
const PAYABLE = 11100 // PRICE + 11 % PPN

let store = null
let category = null
let product = null
let qrProduct = null
let table = null
let qrTable = null
let token = null

beforeAll(async () => {
  store = await db.location.create({ name: unique('ERRC_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('ERRC_CAT') })
  product = await db.product.create({
    nameProduct: unique('ERRC_P'),
    category: category.id,
    price: PRICE,
    stock: 20
  })
  qrProduct = await db.product.create({
    nameProduct: unique('ERRC_QR'),
    category: category.id,
    price: PRICE,
    stock: 20,
    isAvailable: true
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 20 })
  await db.product_store_stock.create({ product: qrProduct.id, store: store.id, stock: 20 })
  table = await db.table.create({ store: store.id, name: unique('ERRC_T') })
  qrTable = await db.table.create({ store: store.id, name: unique('ERRC_QRT') })
  // Expired promo code: the resolver drops it silently (no discount).
  await db.discount.create({
    store: store.id,
    name: unique('ERRC_EXPIRED'),
    code: 'ERRCEXPIRED',
    type: 'nominal',
    value: 1000,
    status: 'active',
    endDate: new Date(Date.now() - 86400000)
  })
  await db.user.create({
    id: 7211,
    userName: 'errc_kasir',
    email: 'p14-7211-order-create-error-contract@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store.id,
    status: 'active',
    fullName: 'errc_kasir'
  })
  token = await signSessionToken(
    { id: 7211, userName: 'errc_kasir', roleType: 'kasir', store: store.id },
    JWT_SECRET
  )
  await db.taxConfig.create({ name: 'ERRC_PPN', rate: 11, type: 'ppn', status: 'active', store: store.id })
  await db.cashRegister.create({ store: store.id, user: 7211, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  const orders = await db.order.findAll({ where: { store: store?.id } })
  for (const o of orders) {
    await db.order_item.destroy({ where: { order: o.id }, force: true })
    await db.order_status.destroy({ where: { order: o.id }, force: true })
    await db.transaction.destroy({ where: { order: o.id }, force: true })
    await db.order.destroy({ where: { id: o.id }, force: true })
  }
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.user.destroy({ where: { id: [7211] }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.discount.destroy({ where: { store: store?.id }, force: true })
  await db.table.destroy({ where: { store: store?.id }, force: true })
  const productIds = [product?.id, qrProduct?.id].filter(Boolean)
  await db.best_selling.destroy({ where: { productId: productIds }, force: true })
  await db.stock_history.destroy({ where: { product: productIds }, force: true })
  await db.product_store_stock.destroy({ where: { product: productIds }, force: true })
  await db.product.destroy({ where: { id: productIds }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

const sale = (key, extra = {}) => ({
  store: store.id,
  items: [{ product: product.id, quantity: 1, productName: product.nameProduct }],
  paymentMethod: 'cash',
  cashierName: 'ERRC',
  idempotencyKey: key,
  ...extra
})
const postSale = (body) =>
  request(app).post('/order/create').set('Authorization', `Bearer ${token}`).send(body)
const stockOf = async (id) =>
  Number((await db.product_store_stock.findOne({ where: { product: id, store: store.id } })).stock)

describe('DR-23 §M TOTAL_CHANGED (expectedTotal)', () => {
  test('a stated payable that differs from the server payable is refused before any write', async () => {
    const key = unique('tc_wrong')
    const [ledgerBefore, stockBefore] = [await db.transaction.count(), await stockOf(product.id)]
    const res = await postSale(sale(key, { expectedTotal: PAYABLE - 1 }))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'TOTAL_CHANGED',
      expectedTotal: PAYABLE - 1,
      totalPrice: PAYABLE
    })
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0)
    expect(await db.transaction.count()).toBe(ledgerBefore)
    expect(await stockOf(product.id)).toBe(stockBefore)
  })

  test('a promo that stopped applying is no longer silent when the client states its total', async () => {
    // The client was shown 11,100 − 1,000 discount × 1.11; the promo has expired.
    const res = await postSale(
      sale(unique('tc_promo'), { promoCode: 'ERRCEXPIRED', expectedTotal: 9990 })
    )
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TOTAL_CHANGED')
    expect(res.body.totalPrice).toBe(PAYABLE)
    expect(res.body.discountAmount).toBe(0)
  })

  test('a matching stated payable sells normally; omitting it keeps legacy behaviour', async () => {
    expect((await postSale(sale(unique('tc_ok'), { expectedTotal: PAYABLE }))).status).toBe(201)
    expect((await postSale(sale(unique('tc_legacy')))).status).toBe(201)
  })

  test('a malformed expectedTotal is a 400 validation error, never a 409', async () => {
    const res = await postSale(sale(unique('tc_bad'), { expectedTotal: -5 }))
    expect(res.status).toBe(400)
  })
})

describe('machine-readable refusal codes (status unchanged)', () => {
  test('insufficient stock → 400 INSUFFICIENT_STOCK', async () => {
    const res = await postSale(
      sale(unique('c_stock'), {
        items: [{ product: product.id, quantity: 9999, productName: product.nameProduct }]
      })
    )
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INSUFFICIENT_STOCK')
  })

  test('unknown product → 400 PRODUCT_NOT_FOUND', async () => {
    const res = await postSale(
      sale(unique('c_prod'), { items: [{ product: 99999999, quantity: 1, productName: 'x' }] })
    )
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('PRODUCT_NOT_FOUND')
  })

  test('occupied table → 400 TABLE_OCCUPIED', async () => {
    expect((await postSale(sale(unique('c_tbl1'), { tableId: table.id }))).status).toBe(201)
    const res = await postSale(sale(unique('c_tbl2'), { tableId: table.id }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('TABLE_OCCUPIED')
  })
})

describe('outcome honesty', () => {
  test('an unexpected pre-commit failure is a generic 500 with no internal detail and no effect', async () => {
    const key = unique('o_500')
    resolveAttributedRegister.mockImplementationOnce(async () => {
      throw new Error('relation "secret_internal_table" does not exist')
    })
    const res = await postSale(sale(key))
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' })
    expect(JSON.stringify(res.body)).not.toContain('secret_internal_table')
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0)
  })

  test('a failure after commit still reports the committed sale (201), and a retry replays it', async () => {
    const key = unique('o_post')
    emitNewOrder.mockImplementationOnce(() => {
      throw new Error('socket layer down')
    })
    const res = await postSale(sale(key))
    expect(res.status).toBe(201)
    const orders = await db.order.findAll({ where: { idempotencyKey: key } })
    expect(orders).toHaveLength(1)
    expect(res.body.data.id).toBe(orders[0].id)
    expect(await db.transaction.count({ where: { order: orders[0].id } })).toBe(1)

    const retry = await postSale(sale(key))
    expect(retry.status).toBe(200)
    expect(retry.body.data.id).toBe(orders[0].id)
  })
})

describe('settlement retry after a lost response (DR-23 §K/§M)', () => {
  test('OUTSTANDING_CHANGED carries the ledger state, so "already settled" is machine-readable', async () => {
    const created = await request(app)
      .post('/order/customer-create')
      .send({
        store: store.id,
        tableId: qrTable.id,
        customerName: 'ERRC diner',
        idempotencyKey: unique('o_qr'),
        items: [{ productId: qrProduct.id, productName: qrProduct.nameProduct, quantity: 1 }]
      })
    expect(created.status).toBe(201)
    const orderId = created.body.data.id
    const settle = () =>
      request(app)
        .put('/order/update-status')
        .set('Authorization', `Bearer ${token}`)
        .send({ id: orderId, store: store.id, status: 'paid', paymentMethod: 'cash' })

    const first = await settle()
    expect(first.status).toBe(200)
    const payable = Number((await db.order.findByPk(orderId)).totalPrice)

    // the response was lost; the client retries the same settlement
    const retry = await settle()
    expect(retry.status).toBe(409)
    expect(retry.body).toMatchObject({
      code: 'OUTSTANDING_CHANGED',
      outstanding: 0,
      financialState: 'PAID',
      netPayable: payable,
      collected: payable
    })
    expect(await db.transaction.count({ where: { order: orderId } })).toBe(1)
  })
})
