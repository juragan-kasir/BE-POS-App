process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// E2E audit #6 (batch B8): a payment records which of the store's payment
// types was used — "GoPay" and "QRIS" are both E_WALLET — as a name snapshot
// on the order and its ledger row. typePaymentId is optional; a type of
// another store, an inactive one, or one of a different tender is refused
// with 422 before anything is written.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const PRICE = 50000
const STOCK = 500

let store = null
let otherStore = null
let category = null
let product = null
let adminToken = null
const types = {}

const sell = (body) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(
      withIdempotencyKey({
        store: store.id,
        items: [{ product: product.id, quantity: 1 }],
        cashierName: 'PMN',
        paymentMethod: 'e-wallet',
        referenceNumber: unique('REF'),
        ...body
      })
    )

const makeType = (key, fields) =>
  db.type_payment
    .create({ store: store.id, status: 'active', ...fields })
    .then((row) => {
      types[key] = row
    })

beforeAll(async () => {
  store = await db.location.create({ name: unique('PMN_STORE'), status: 'active' })
  otherStore = await db.location.create({ name: unique('PMN_OTHER'), status: 'active' })
  category = await db.category.create({ name: unique('PMN_CAT') })
  product = await db.product.create({
    nameProduct: unique('PMN_PRODUCT'),
    category: category.id,
    price: PRICE,
    stock: STOCK
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: STOCK })
  await db.taxConfig.create({
    store: store.id,
    name: `PMN_PPN_${store.id}`,
    rate: 0,
    type: 'ppn',
    status: 'active'
  })
  await makeType('gopay', { name: 'GoPay', type: 'e-wallet' })
  await makeType('qris', { name: 'QRIS', type: 'e-wallet' })
  await makeType('debit', { name: 'Debit BCA', type: 'debit' })
  await makeType('inactive', { name: 'OVO', type: 'e-wallet', status: 'inactive' })
  await makeType('foreign', { name: 'Dana', type: 'e-wallet', store: otherStore.id })
  const admin = await db.user.create({
    userName: unique('admin_pmn'),
    email: `${unique('admin_pmn')}@test.com`,
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
  await db.type_payment.destroy({
    where: { id: Object.values(types).map((t) => t.id) },
    force: true
  })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: [store?.id, otherStore?.id] }, force: true })
})

const recorded = async (orderId) => {
  const order = await db.order.findByPk(orderId)
  const [row] = await db.transaction.findAll({ where: { order: orderId } })
  return { order, row }
}

describe('payment method name (batch B8)', () => {
  test('two payment types of one tender are told apart on the order and ledger', async () => {
    const gopay = await sell({ typePaymentId: types.gopay.id })
    const qris = await sell({ typePaymentId: types.qris.id })
    expect(gopay.status).toBe(201)
    expect(qris.status).toBe(201)

    const a = await recorded(gopay.body.data.id)
    expect(a.order.paymentMethod).toBe('E_WALLET')
    expect(a.order.paymentMethodName).toBe('GoPay')
    expect(a.row.typePayment).toBe('E_WALLET')
    expect(a.row.paymentMethodName).toBe('GoPay')

    const b = await recorded(qris.body.data.id)
    expect(b.order.paymentMethodName).toBe('QRIS')
    expect(b.row.paymentMethodName).toBe('QRIS')
  })

  test('without typePaymentId the sale is recorded as before, with no name', async () => {
    const res = await sell({})
    expect(res.status).toBe(201)
    const { order, row } = await recorded(res.body.data.id)
    expect(order.paymentMethodName).toBeNull()
    expect(row.paymentMethodName).toBeNull()
  })

  test.each([
    ['a type of a different tender', 'debit', 'PAYMENT_TYPE_MISMATCH'],
    ['an inactive type', 'inactive', 'PAYMENT_TYPE_NOT_FOUND'],
    ["another store's type", 'foreign', 'PAYMENT_TYPE_NOT_FOUND']
  ])('%s is refused with no effect', async (_label, key, code) => {
    const before = await db.order.count({ where: { store: store.id } })
    const res = await sell({ typePaymentId: types[key].id })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(code)
    expect(await db.order.count({ where: { store: store.id } })).toBe(before)
  })

  test('the store dashboard breaks payments down by type name', async () => {
    const today = new Date()
    const day = (offset) => new Date(today.getTime() + offset * 86400000).toISOString().slice(0, 10)
    const res = await request(app)
      .get('/pos/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ startDate: day(-1), endDate: day(1) })
    expect(res.status).toBe(200)
    const names = res.body.data.paymentMethods
      .filter((r) => r.method === 'E_WALLET')
      .map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['GoPay', 'QRIS', null]))
  })
})
