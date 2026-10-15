process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// DR-04-002: PUT /order/update-status { status: 'paid' } must settle with a
// complete tender — actual method, server-validated cash detail when cash,
// and drawer attribution via an open register — instead of the old
// amount-only pseudo-tender with no register link.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let storeNoRegister = null
let category = null
let product = null
let adminToken = null
let adminNoRegToken = null
let registerId = null
const createdTableIds = []

const PRICE = 50000

async function makeTable(storeId) {
  const t = await db.table.create({ store: storeId, name: `DR04_TABLE_${Date.now()}_${Math.floor(Math.random() * 1e6)}` })
  createdTableIds.push(t.id)
  return t
}

async function makeQrOrder({ storeId, paymentMethod, items } = {}) {
  // One open QR order per table: every QR order gets a fresh table.
  const table = await makeTable(storeId)
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: storeId,
      tableId: table.id,
      ...(paymentMethod === undefined ? {} : { paymentMethod }),
      customerName: 'DR04 QR',
      items: items || [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
      idempotencyKey: unique('dr04qr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function settlePaid(body) {
  return request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(body)
}

async function txnRows(orderId) {
  return db.transaction.findAll({ where: { order: orderId } })
}

beforeAll(async () => {
  store = await db.location.create({ name: `DR04_STORE_${Date.now()}`, status: 'active' })
  storeNoRegister = await db.location.create({ name: `DR04_NOREG_${Date.now()}`, status: 'active' })
  category = await db.category.create({ name: `DR04_CAT_${Date.now()}` })
  product = await db.product.create({
    nameProduct: `DR04_PRODUCT_${Date.now()}`,
    category: category.id,
    price: PRICE,
    stock: 500
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 500 })
  await db.product_store_stock.create({ product: product.id, store: storeNoRegister.id, stock: 500 })
  // Explicit 0% PPN: valid setup under W3-3, keeps the due exactly PRICE.
  await db.taxConfig.create({
    store: store.id,
    name: `DR04_PPN_${store.id}`,
    rate: 0,
    type: 'ppn',
    status: 'active'
  })
  await db.taxConfig.create({
    store: storeNoRegister.id,
    name: `DR04_PPN_${storeNoRegister.id}`,
    rate: 0,
    type: 'ppn',
    status: 'active'
  })
  
  const adminUser = await db.user.create({
    userName: `admin_dr04_${Date.now()}`,
    email: `admin_dr04_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  const adminNoRegUser = await db.user.create({
    userName: `admin_dr04nr_${Date.now()}`,
    email: `admin_dr04nr_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: storeNoRegister.id,
    status: 'active'
  })
  adminNoRegToken = await signSessionToken(
    { id: adminNoRegUser.id, userName: adminNoRegUser.userName, roleType: 'admin', store: storeNoRegister.id },
    JWT_SECRET
  )

  const openRes = await request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: store.id, openingBalance: 100000, shift: 1 })
  if (openRes.status !== 201 && openRes.status !== 200) {
    throw new Error('register setup failed: ' + JSON.stringify(openRes.body))
  }
  registerId = openRes.body.data.id
})

afterAll(async () => {
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: [store?.id, storeNoRegister?.id].filter(Boolean) }, force: true })
  await db.cashMovement.destroy({ where: {}, force: true })
  await db.cashRegister.destroy({ where: { store: [store?.id, storeNoRegister?.id].filter(Boolean) }, force: true })
  await db.best_selling.destroy({ where: { store: [store?.id, storeNoRegister?.id].filter(Boolean) }, force: true })
  await db.product_store_stock.destroy({ where: { store: [store?.id, storeNoRegister?.id].filter(Boolean) }, force: true })
  await db.stock_history.destroy({ where: { store: [store?.id, storeNoRegister?.id].filter(Boolean) }, force: true })
  await db.taxConfig.destroy({ where: { store: [store?.id, storeNoRegister?.id].filter(Boolean) }, force: true })
  await db.table.destroy({ where: { id: createdTableIds }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: [store?.id, storeNoRegister?.id].filter(Boolean) }, force: true })
  await db.location.destroy({ where: { id: [store?.id, storeNoRegister?.id].filter(Boolean) }, force: true })
})

describe('DR-04 update-status settlement tender', () => {
  test('cash with valid tender persists method, cash detail and register attribution', async () => {
    const order = await makeQrOrder({ storeId: store.id })
    expect(order.paymentStatus).toBe('unpaid')

    const res = await settlePaid({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      cashAmount: 60000,
      changeAmount: 10000
    })
    expect(res.status).toBe(200)

    const settled = await db.order.findByPk(order.id)
    expect(settled.paymentStatus).toBe('paid')
    expect(settled.paymentMethod).toBe('CASH')
    expect(Number(settled.cashRegisterId)).toBe(Number(registerId))

    const rows = await txnRows(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].typePayment).toBe('CASH')
    expect(Number(rows[0].amount)).toBe(PRICE)
    expect(Number(rows[0].cashReceived)).toBe(60000)
    expect(Number(rows[0].changeGiven)).toBe(10000)
  })

  test('non-cash persists the selected method with no fabricated cash fields', async () => {
    const order = await makeQrOrder({ storeId: store.id, paymentMethod: 'qris' })

    // DR-23 §D: a manually confirmed QRIS settlement carries its reference.
    const res = await settlePaid({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'qris',
      referenceNumber: 'QR-DR04-1'
    })
    expect(res.status).toBe(200)

    const settled = await db.order.findByPk(order.id)
    expect(settled.paymentMethod).toBe('QRIS')
    expect(Number(settled.cashRegisterId)).toBe(Number(registerId))

    const rows = await txnRows(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].typePayment).toBe('QRIS')
    expect(Number(rows[0].amount)).toBe(PRICE)
    expect(rows[0].cashReceived).toBeNull()
    expect(Number(rows[0].changeGiven)).toBe(0)
  })

  test('body method overrides a stale order intent', async () => {
    const order = await makeQrOrder({ storeId: store.id, paymentMethod: 'qris' })

    const res = await settlePaid({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      cashAmount: PRICE,
      changeAmount: 0
    })
    expect(res.status).toBe(200)
    expect((await db.order.findByPk(order.id)).paymentMethod).toBe('CASH')
    const rows = await txnRows(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].typePayment).toBe('CASH')
    expect(Number(rows[0].cashReceived)).toBe(PRICE)
  })

  test('method-less order settled without a method fails closed and stays unpaid', async () => {
    const order = await makeQrOrder({ storeId: store.id })

    const before = await txnRows(order.id)
    const res = await settlePaid({ id: order.id, store: store.id, status: 'paid' })
    expect(res.status).toBe(422)
    expect(String(res.body.message || res.body.error || '')).toMatch(/paymentMethod/i)

    const settled = await db.order.findByPk(order.id)
    expect(settled.paymentStatus).toBe('unpaid')
    expect(await txnRows(order.id)).toHaveLength(before.length)
  })

  test('unknown payment method is refused with 422 before any persistence', async () => {
    const order = await makeQrOrder({ storeId: store.id })
    const res = await settlePaid({ id: order.id, store: store.id, status: 'paid', paymentMethod: 'gold-bars' })
    // P1 (DR-PAY-ATTR-06): unknown tenders reach the canonicalizer, which
    // refuses with 422 — the old shape-boundary 400 is superseded.
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('INVALID_PAYMENT_METHOD')
    expect((await db.order.findByPk(order.id)).paymentStatus).toBe('unpaid')
  })

  test('under-tendered cash fails validation with nothing persisted', async () => {
    const order = await makeQrOrder({ storeId: store.id })
    const res = await settlePaid({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      cashAmount: 10000,
      changeAmount: 0
    })
    expect(res.status).toBe(422)
    expect((await db.order.findByPk(order.id)).paymentStatus).toBe('unpaid')
    expect(await txnRows(order.id)).toHaveLength(0)
  })

  test('one-sided cash tender fails validation with nothing persisted', async () => {
    const order = await makeQrOrder({ storeId: store.id })
    const res = await settlePaid({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      cashAmount: 60000
    })
    expect(res.status).toBe(422)
    expect((await db.order.findByPk(order.id)).paymentStatus).toBe('unpaid')
    expect(await txnRows(order.id)).toHaveLength(0)
  })

  test('settlement with no open register fails closed and stays unpaid', async () => {
    const order = await makeQrOrder({ storeId: storeNoRegister.id })
    const res = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminNoRegToken}`)
      .send({
        id: order.id,
        store: storeNoRegister.id,
        status: 'paid',
        paymentMethod: 'cash',
        cashAmount: PRICE,
        changeAmount: 0
      })
    expect(res.status).toBe(422)
    expect(String(res.body.message || res.body.error || '')).toMatch(/register/i)

    const settled = await db.order.findByPk(order.id)
    expect(settled.paymentStatus).toBe('unpaid')
    expect(settled.cashRegisterId).toBeNull()
    expect(await txnRows(order.id)).toHaveLength(0)
  })

  test('expected cash uses cashReceived minus changeGiven, not the amount', async () => {
    const beforeRes = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ store: store.id })
    expect(beforeRes.status).toBe(200)
    const beforeCash = Number(beforeRes.body.data.cashSalesReceived || 0)

    const order = await makeQrOrder({ storeId: store.id })
    const paid = await settlePaid({
      id: order.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash',
      cashAmount: 100000,
      changeAmount: PRICE
    })
    expect(paid.status).toBe(200)

    const afterRes = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ store: store.id })
    expect(afterRes.status).toBe(200)
    // Net +PRICE (100000 received - 50000 change), never +100000 amount.
    expect(Number(afterRes.body.data.cashSalesReceived)).toBe(beforeCash + PRICE)
  })

  test('an already-settled order keeps its single settlement row untouched', async () => {
    const createRes = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashAmount: PRICE,
        changeAmount: 0,
        cashierName: 'DR04',
        idempotencyKey: unique('dr04create')
      })
    expect(createRes.status).toBe(201)
    const orderId = createRes.body.data.id

    // DR-23 (BA §35.10 K): a repeated settlement is refused on the fresh
    // state (outstanding is 0) instead of a 200 no-op that hides the
    // duplicate; the single settlement row stays untouched either way.
    const res = await settlePaid({ id: orderId, store: store.id, status: 'paid', paymentMethod: 'cash' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('OUTSTANDING_CHANGED')

    const rows = await txnRows(orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0].typePayment).toBe('CASH')
    expect(Number(rows[0].cashReceived)).toBe(PRICE)
    expect(Number(rows[0].changeGiven)).toBe(0)
  })
})
