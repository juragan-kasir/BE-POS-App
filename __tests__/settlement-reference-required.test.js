process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// DR-23 §D / §M (BA §35.10): a manually confirmed non-cash settlement
// (PUT /order/update-status { status: 'paid' }) must carry its reference —
// every tender but CASH and POINTS, the same set split payments and void
// refunds already require one for. Missing or whitespace-only → 422
// REFERENCE_REQUIRED with no effect; a valid reference is stored trimmed on
// the ledger row. Cash never needs one, and legacy ledger rows without a
// reference stay readable and reportable.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const PRICE = 50000

let store = null
let category = null
let product = null
let adminToken = null
const createdTableIds = []
const createdOrderIds = []

async function makeQrOrder({ paymentMethod } = {}) {
  const table = await db.table.create({ store: store.id, name: unique('SREF_TABLE') })
  createdTableIds.push(table.id)
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      ...(paymentMethod === undefined ? {} : { paymentMethod }),
      customerName: 'SREF QR',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
      idempotencyKey: unique('srefqr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  createdOrderIds.push(res.body.data.id)
  return res.body.data
}

const settlePaid = (body) =>
  request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: store.id, status: 'paid', ...body })

const ledgerRows = (orderId) => db.transaction.findAll({ where: { order: orderId } })

const expectRefusedWithoutEffect = async (res, orderId) => {
  expect(res.status).toBe(422)
  expect(res.body.code).toBe('REFERENCE_REQUIRED')
  const order = await db.order.findByPk(orderId)
  expect(order.paymentStatus).toBe('unpaid')
  expect(await ledgerRows(orderId)).toHaveLength(0)
  expect(await db.accounting_outbox.count({ where: { referenceId: orderId } })).toBe(0)
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('SREF_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('SREF_CAT') })
  product = await db.product.create({
    nameProduct: unique('SREF_PRODUCT'),
    category: category.id,
    price: PRICE,
    stock: 500
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 500 })
  // Explicit 0% PPN keeps the due exactly PRICE.
  await db.taxConfig.create({
    store: store.id,
    name: `SREF_PPN_${store.id}`,
    rate: 0,
    type: 'ppn',
    status: 'active'
  })
  const admin = await db.user.create({
    userName: unique('admin_sref'),
    email: `${unique('admin_sref')}@test.com`,
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
  const orderIds = createdOrderIds
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
  await db.table.destroy({ where: { id: createdTableIds }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('settlement reference (DR-23 §D)', () => {
  test('cash settles without a reference and stores none', async () => {
    const order = await makeQrOrder()
    const res = await settlePaid({ id: order.id, paymentMethod: 'cash', cashAmount: PRICE, changeAmount: 0 })
    expect(res.status).toBe(200)
    const rows = await ledgerRows(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].typePayment).toBe('CASH')
    expect(rows[0].referenceNumber).toBeNull()
  })

  test('cash ignores a stray reference (never stored on a cash row)', async () => {
    const order = await makeQrOrder()
    const res = await settlePaid({
      id: order.id,
      paymentMethod: 'cash',
      cashAmount: PRICE,
      changeAmount: 0,
      referenceNumber: 'IGNORED'
    })
    expect(res.status).toBe(200)
    expect((await ledgerRows(order.id))[0].referenceNumber).toBeNull()
  })

  test.each([
    ['qris', 'QRIS'],
    ['debit', 'CARD'],
    ['transfer', 'BANK_TRANSFER'],
    ['e-wallet', 'E_WALLET'],
    ['other', 'OTHER']
  ])('%s (%s) without a reference is refused with no effect', async (input) => {
    const order = await makeQrOrder()
    await expectRefusedWithoutEffect(await settlePaid({ id: order.id, paymentMethod: input }), order.id)
  })

  test.each([
    ['empty', ''],
    ['whitespace-only', '   \t '],
    ['null', null]
  ])('a %s reference is refused with no effect', async (_label, referenceNumber) => {
    const order = await makeQrOrder()
    const res = await settlePaid({ id: order.id, paymentMethod: 'qris', referenceNumber })
    await expectRefusedWithoutEffect(res, order.id)
  })

  test('a valid reference is accepted and stored trimmed on the ledger row', async () => {
    const order = await makeQrOrder()
    const res = await settlePaid({ id: order.id, paymentMethod: 'debit', referenceNumber: '  APPR-778899  ' })
    expect(res.status).toBe(200)
    const rows = await ledgerRows(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].typePayment).toBe('CARD')
    expect(rows[0].referenceNumber).toBe('APPR-778899')
    expect(rows[0].cashReceived).toBeNull()
    expect((await db.order.findByPk(order.id)).paymentStatus).toBe('paid')
    // a successful settlement enqueues its journal (so the zero-outbox
    // assertion on refusals is meaningful)
    expect(await db.accounting_outbox.count({ where: { referenceId: order.id } })).toBeGreaterThan(0)
  })

  test('a refused settlement can be retried with the reference and settles exactly once', async () => {
    const order = await makeQrOrder()
    await expectRefusedWithoutEffect(await settlePaid({ id: order.id, paymentMethod: 'qris' }), order.id)
    const ok = await settlePaid({ id: order.id, paymentMethod: 'qris', referenceNumber: 'QR-RETRY-1' })
    expect(ok.status).toBe(200)
    // the existing stale-settlement protection still refuses a second collection
    const again = await settlePaid({ id: order.id, paymentMethod: 'qris', referenceNumber: 'QR-RETRY-1' })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('OUTSTANDING_CHANGED')
    const rows = await ledgerRows(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].referenceNumber).toBe('QR-RETRY-1')
  })

  test('a retry after a lost response finds the order PAID (M1), even without the reference', async () => {
    const order = await makeQrOrder()
    expect((await settlePaid({ id: order.id, paymentMethod: 'qris', referenceNumber: 'QR-LOST-1' })).status).toBe(200)
    // the outstanding check precedes the tender/reference check, so the
    // client still learns the order is already paid — never a 422
    const retry = await settlePaid({ id: order.id, paymentMethod: 'qris' })
    expect(retry.status).toBe(409)
    expect(retry.body).toMatchObject({ code: 'OUTSTANDING_CHANGED', outstanding: 0, financialState: 'PAID' })
    expect(await ledgerRows(order.id)).toHaveLength(1)
  })

  test('the tender taken from the order itself (no paymentMethod in the request) also needs a reference', async () => {
    const order = await makeQrOrder({ paymentMethod: 'qris' })
    await expectRefusedWithoutEffect(await settlePaid({ id: order.id }), order.id)
    const ok = await settlePaid({ id: order.id, referenceNumber: 'QR-ORDER-TENDER' })
    expect(ok.status).toBe(200)
    const rows = await ledgerRows(order.id)
    expect(rows[0].typePayment).toBe('QRIS')
    expect(rows[0].referenceNumber).toBe('QR-ORDER-TENDER')
  })

  test('a legacy ledger row without a reference stays readable and reportable', async () => {
    const legacy = await db.order.create({
      orderNumber: unique('SREF-LEGACY'),
      store: store.id,
      status: 'served',
      paymentStatus: 'paid',
      subTotal: 30000,
      totalPrice: 30000,
      totalQuantity: 1,
      paymentMethod: 'QRIS',
      source: 'qr'
    })
    createdOrderIds.push(legacy.id)
    await db.transaction.create({
      order: legacy.id,
      typePayment: 'QRIS',
      amount: 30000,
      cashReceived: null,
      changeGiven: 0,
      referenceNumber: null
    })
    const fresh = await makeQrOrder()
    expect((await settlePaid({ id: fresh.id, paymentMethod: 'qris', referenceNumber: 'QR-NEW-1' })).status).toBe(200)

    const day = new Date().toISOString().slice(0, 10)
    const res = await request(app)
      .get('/report/cash-flow')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ store: store.id, startDate: day, endDate: day })
    expect(res.status).toBe(200)
    // Every QRIS row of this store counts: the legacy NULL-reference row,
    // the fresh one, and the earlier QRIS settlements of this suite.
    const qrisRows = await db.transaction.findAll({
      where: { order: createdOrderIds, typePayment: 'QRIS' }
    })
    expect(qrisRows.some((r) => r.referenceNumber === null)).toBe(true)
    const expectedQris = qrisRows.reduce((sum, r) => sum + Number(r.amount), 0)
    expect(res.body.data.penerimaanQris).toBe(expectedQris)
  })
})
