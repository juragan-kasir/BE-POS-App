process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-IDEM-1 (AR payment): the bank/gateway `reference` doubles as the
// deduplication identity via the (arId, reference) partial unique index.
// Same reference + same amount must replay; same reference + different
// amount must not silently replay the winner — it answers 409. (A real
// idempotencyKey column would be a schema change and is out of scope.)

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let adminToken = null
let order = null
let product = null
let category = null

async function makeAR(total) {
  return db.accounts_receivable.create({
    store: store.id,
    orderId: order.id,
    totalAmount: total,
    paidAmount: 0,
    outstandingAmount: total,
    status: 'UNPAID'
  })
}

async function payAR(arId, body) {
  return request(app)
    .post(`/accounts-receivable/${arId}/pay`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ paymentMethod: 'cash', ...body })
}

beforeAll(async () => {
  store = await db.location.create({ name: `ARIDEM_STORE_${Date.now()}`, status: 'active' })
  category = await db.category.create({ name: `ARIDEM_CAT_${Date.now()}` })
  product = await db.product.create({
    nameProduct: `ARIDEM_PRODUCT_${Date.now()}`,
    category: category.id,
    price: 50000,
    stock: 100
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 100 })
  const adminUser = await db.user.create({
    userName: `admin_aridem_${Date.now()}`,
    email: `admin_aridem_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so this order setup exercises configured tax.
  await db.taxConfig.create({
    name: 'ARIDEM_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: store.id, user: adminUser.id, status: 'open', openingBalance: 0, openedAt: new Date() })
  const orderRes = await request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(withIdempotencyKey({
      store: store.id,
      items: [{ product: product.id, quantity: 1, productName: 'aridem' }],
      paymentMethod: 'cash',
      cashierName: 'AR Cashier'
    }))
  if (orderRes.status !== 201) throw new Error('order setup failed')
  order = await db.order.findByPk(orderRes.body.data.id)
})

afterAll(async () => {
  await db.ar_payment.destroy({ where: {}, force: true })
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.accounts_receivable.destroy({ where: { store: store?.id }, force: true })
  await db.order_item.destroy({ where: { order: order?.id }, force: true })
  await db.transaction.destroy({ where: { order: order?.id }, force: true })
  await db.order_status.destroy({ where: { order: order?.id }, force: true })
  await db.order.destroy({ where: { id: order?.id }, force: true })
  await db.best_selling.destroy({ where: { store: store?.id }, force: true })
  await db.stock_history.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F-IDEM-1 AR-payment reference mismatch', () => {
  test('A — same reference + same amount replays without a second payment', async () => {
    const ar = await makeAR(200000)
    const ref = unique('arA')
    const first = await payAR(ar.id, { amount: 50000, reference: ref })
    expect(first.status).toBe(201)

    const retry = await payAR(ar.id, { amount: 50000, reference: ref })
    expect(retry.status).toBe(200)
    expect(retry.body?.data?.id).toBe(first.body?.data?.id)
    expect(await db.ar_payment.count({ where: { arId: ar.id, reference: ref } })).toBe(1)
    const fresh = await db.accounts_receivable.findByPk(ar.id)
    expect(Number(fresh.paidAmount)).toBe(50000)
  })

  test('B — same reference + different amount is rejected without a second payment', async () => {
    const ar = await makeAR(200000)
    const ref = unique('arB')
    const first = await payAR(ar.id, { amount: 50000, reference: ref })
    expect(first.status).toBe(201)

    const retry = await payAR(ar.id, { amount: 80000, reference: ref })
    expect(retry.status).toBe(409)
    expect(await db.ar_payment.count({ where: { arId: ar.id, reference: ref } })).toBe(1)
    const fresh = await db.accounts_receivable.findByPk(ar.id)
    expect(Number(fresh.paidAmount)).toBe(50000)
  })

  test('C — concurrent same-reference requests apply exactly once', async () => {
    const ar = await makeAR(200000)
    const ref = unique('arC')
    const payload = { amount: 40000, reference: ref }
    const [r1, r2] = await Promise.all([payAR(ar.id, payload), payAR(ar.id, payload)])
    expect([r1.status, r2.status].sort()).toEqual([200, 201])
    expect(await db.ar_payment.count({ where: { arId: ar.id, reference: ref } })).toBe(1)
    const fresh = await db.accounts_receivable.findByPk(ar.id)
    expect(Number(fresh.paidAmount)).toBe(40000)
  })

  test('D — different references pay independently', async () => {
    const ar = await makeAR(200000)
    const r1 = await payAR(ar.id, { amount: 30000, reference: unique('arD1') })
    const r2 = await payAR(ar.id, { amount: 30000, reference: unique('arD2') })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r2.body?.data?.id).not.toBe(r1.body?.data?.id)
    const fresh = await db.accounts_receivable.findByPk(ar.id)
    expect(Number(fresh.paidAmount)).toBe(60000)
  })
})
