process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// DR-23 §D / §O (BA gap G-02): a counter sale (POST /order/create) states
// its tender explicitly — an omitted method is refused, never assumed to be
// cash — and a manually confirmed tender (CARD, BANK_TRANSFER, E_WALLET,
// QRIS) carries its transaction reference; OTHER carries a description.
// Every refusal happens before any write: no order, no ledger row, no stock.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const PRICE = 50000
const STOCK = 500

let store = null
let category = null
let product = null
let adminToken = null

const sell = (body) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(
      withIdempotencyKey({
        store: store.id,
        items: [{ product: product.id, quantity: 1 }],
        cashierName: 'G02',
        ...body
      })
    )

const outletStock = async () =>
  Number((await db.product_store_stock.findOne({ where: { product: product.id, store: store.id } })).stock)

const expectNoEffect = async (res, status, code, ordersBefore, stockBefore) => {
  expect(res.status).toBe(status)
  expect(res.body.code).toBe(code)
  expect(await db.order.count({ where: { store: store.id } })).toBe(ordersBefore)
  expect(await outletStock()).toBe(stockBefore)
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('G02_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('G02_CAT') })
  product = await db.product.create({
    nameProduct: unique('G02_PRODUCT'),
    category: category.id,
    price: PRICE,
    stock: STOCK
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: STOCK })
  // Explicit 0% PPN keeps the due exactly PRICE.
  await db.taxConfig.create({
    store: store.id,
    name: `G02_PPN_${store.id}`,
    rate: 0,
    type: 'ppn',
    status: 'active'
  })
  const admin = await db.user.create({
    userName: unique('admin_g02'),
    email: `${unique('admin_g02')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  const open = await request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: store.id, openingBalance: 100000, shift: 1 })
  if (open.status !== 201 && open.status !== 200) {
    throw new Error('register setup failed: ' + JSON.stringify(open.body))
  }
})

afterAll(async () => {
  const orderIds = (await db.order.findAll({ where: { store: store?.id }, paranoid: false })).map(
    (o) => o.id
  )
  await db.accounting_outbox.destroy({ where: { store: store?.id }, force: true })
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.order.destroy({ where: { store: store?.id }, force: true })
  const registerIds = (await db.cashRegister.findAll({ where: { store: store?.id } })).map((r) => r.id)
  await db.cashMovement.destroy({ where: { cashRegisterId: registerIds }, force: true })
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store?.id }, force: true })
  await db.stock_history.destroy({ where: { store: store?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('counter sale tender (DR-23 §D / §O)', () => {
  test('an omitted payment method is refused, never assumed to be cash', async () => {
    const orders = await db.order.count({ where: { store: store.id } })
    const stock = await outletStock()
    const res = await sell({ cashAmount: PRICE, changeAmount: 0 })
    await expectNoEffect(res, 422, 'PAYMENT_METHOD_REQUIRED', orders, stock)
  })

  test('a blank payment method is refused the same way', async () => {
    const orders = await db.order.count({ where: { store: store.id } })
    const stock = await outletStock()
    const res = await sell({ paymentMethod: '   ' })
    await expectNoEffect(res, 422, 'PAYMENT_METHOD_REQUIRED', orders, stock)
  })

  test.each([['qris'], ['debit'], ['transfer'], ['e-wallet']])(
    'a %s sale without a reference is refused with no effect',
    async (paymentMethod) => {
      const orders = await db.order.count({ where: { store: store.id } })
      const stock = await outletStock()
      const res = await sell({ paymentMethod })
      await expectNoEffect(res, 422, 'REFERENCE_REQUIRED', orders, stock)
      expect(res.body.error || res.body.message).toMatch(/transaction reference/)
    }
  )

  test('a whitespace-only reference counts as missing', async () => {
    const orders = await db.order.count({ where: { store: store.id } })
    const stock = await outletStock()
    const res = await sell({ paymentMethod: 'qris', referenceNumber: '   ' })
    await expectNoEffect(res, 422, 'REFERENCE_REQUIRED', orders, stock)
  })

  test('OTHER without a description is refused and asks for a description', async () => {
    const orders = await db.order.count({ where: { store: store.id } })
    const stock = await outletStock()
    const res = await sell({ paymentMethod: 'other' })
    await expectNoEffect(res, 422, 'REFERENCE_REQUIRED', orders, stock)
    expect(res.body.error || res.body.message).toMatch(/description/)
  })

  test('a non-cash sale with a reference is recorded with the trimmed reference', async () => {
    const ref = unique('QR')
    const res = await sell({ paymentMethod: 'qris', referenceNumber: `  ${ref}  ` })
    expect(res.status).toBe(201)
    const rows = await db.transaction.findAll({ where: { order: res.body.data.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].referenceNumber).toBe(ref)
    expect(rows[0].typePayment).toBe('QRIS')
  })

  test('OTHER with a description is recorded with it', async () => {
    const res = await sell({ paymentMethod: 'other', referenceNumber: 'voucher perusahaan' })
    expect(res.status).toBe(201)
    const rows = await db.transaction.findAll({ where: { order: res.body.data.id } })
    expect(rows[0].referenceNumber).toBe('voucher perusahaan')
  })

  test('cash needs no reference and never stores one', async () => {
    const res = await sell({
      paymentMethod: 'cash',
      cashAmount: PRICE,
      changeAmount: 0,
      referenceNumber: 'stray'
    })
    expect(res.status).toBe(201)
    const rows = await db.transaction.findAll({ where: { order: res.body.data.id } })
    expect(rows[0].referenceNumber).toBeNull()
  })
})
