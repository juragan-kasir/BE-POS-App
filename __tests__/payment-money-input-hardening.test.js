process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-MON-1 regression: monetary amounts that are contractually integer
// rupiah must be rejected before persistence/math — never silently
// truncated (parseInt/Math.floor), rounded by the DB driver, or overflowed
// into a 500. INT4 payment columns additionally cannot hold BIGINT-scale
// totals; the application boundary must fail closed with a clear 422
// instead of a raw DB out-of-range 500 (schema migration itself is a
// separately documented follow-up).

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let category = null
let product = null
let token = null
let adminToken = null
let supplier = null
let po = null
let amountDue = null
let arOrderId = null

async function postOrder(body) {
  return request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${token}`)
    .send(withIdempotencyKey({
      store: store.id,
      items: [{ product: product.id, quantity: 1, productName: 'mon' }],
      paymentMethod: 'cash',
      cashierName: 'Money Cashier',
      ...body
    }))
}

beforeAll(async () => {
  store = await db.location.create({ name: `MON_STORE_${Date.now()}`, status: 'active' })
  category = await db.category.create({ name: `MON_CAT_${Date.now()}` })
  product = await db.product.create({
    nameProduct: `MON_PRODUCT_${Date.now()}`,
    category: category.id,
    price: 10000,
    stock: 100
  })
  await db.product_store_stock.create({
    product: product.id,
    store: store.id,
    stock: 100
  })
  // Split-bill routes require admin; createdBy carries no FK so a synthetic
  // subject matches the existing split-bill-flow convention.
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7601,
    userName: 'cashier_mon',
    email: 'p14-7601-payment-money-input-hardening@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store.id,
    status: 'active',
    fullName: 'cashier_mon'
  })
  await db.user.create({
    id: 7602,
    userName: 'admin_mon',
    email: 'p14-7602-payment-money-input-hardening@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'admin_mon'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  token = await signSessionToken(
    { id: 7601, userName: 'cashier_mon', roleType: 'kasir', store: store.id },
    JWT_SECRET
  )
  adminToken = await signSessionToken(
    { id: 7602, userName: 'admin_mon', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these money-input assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'MON_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  supplier = await db.supplier.create({
    name: `MON_SUP_${Date.now()}`,
    phone: '0800000002'
  })
  po = await db.purchase_order.create({
    store: store.id,
    supplier: supplier.id,
    orderNumber: `MON-PO-${Date.now()}`,
    totalAmount: 1000000,
    finalAmount: 1000000,
    status: 'ordered'
  })

  // Learn the exact amount due (price + tax/service) for fractional probes.
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: store.id, user: 7602, status: 'open', openingBalance: 0, openedAt: new Date() })
  const probe = await postOrder({ idempotencyKey: unique('monProbe') })
  if (probe.status !== 201) throw new Error('money setup failed')
  amountDue = Number(probe.body.data.totalPrice)
  arOrderId = probe.body.data.id
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.user.destroy({ where: { id: [7601, 7602] }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.split_bill.destroy({ where: {}, force: true })
  await db.ar_payment.destroy({ where: {}, force: true })
  await db.accounts_receivable.destroy({ where: { store: store?.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store?.id }, force: true })
  await db.purchase_payment.destroy({ where: { purchaseOrder: po?.id }, force: true })
  const journals = await db.journal_entry.findAll({ where: { store: store?.id } })
  for (const j of journals) {
    await db.journal_entry_line.destroy({ where: { journalEntry: j.id }, force: true })
  }
  await db.journal_entry.destroy({ where: { store: store?.id }, force: true })
  await db.accounting_outbox.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { productId: product?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.purchase_order.destroy({ where: { id: po?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.supplier.destroy({ where: { id: supplier?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

async function makeUnpaidOrder(total) {
  const order = await db.order.create({
    orderNumber: `MON-SPL-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    store: store.id,
    status: 'pending',
    paymentStatus: 'unpaid',
    subTotal: total,
    totalQuantity: 1,
    totalPrice: total,
    source: 'qr'
  })
  await db.order_item.create({
    order: order.id,
    product: product.id,
    productName: product.nameProduct,
    quantity: 1,
    price: total,
    totalPrice: total
  })
  return order
}

describe('F-MON-1 money input safety', () => {
  test('arithmetically-exact fractional cash tender is rejected, not persisted', async () => {
    // 0.5 is exact in binary: (due+0.5) - 0.5 === due passes float
    // equality, so only an explicit integer guard can reject this.
    const key = unique('monFrac')
    const res = await postOrder({
      idempotencyKey: key,
      cashAmount: amountDue + 0.5,
      changeAmount: 0.5
    })
    expect(res.status).toBe(422)
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0)
  })

  test('NaN cash amount is rejected', async () => {
    const res = await postOrder({
      idempotencyKey: unique('monNaN'),
      cashAmount: 'abc',
      changeAmount: 0
    })
    expect([400, 422]).toContain(res.status)
  })

  test('Infinity cash amount is rejected', async () => {
    const res = await postOrder({
      idempotencyKey: unique('monInf'),
      cashAmount: 'Infinity',
      changeAmount: 0
    })
    expect([400, 422]).toContain(res.status)
  })

  test('negative change is rejected', async () => {
    const res = await postOrder({
      idempotencyKey: unique('monNeg'),
      cashAmount: amountDue,
      changeAmount: -1
    })
    expect(res.status).toBe(422)
  })

  test('split-bill fractional amount is rejected, not rounded', async () => {
    const order = await makeUnpaidOrder(50000)
    const res = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        order: order.id,
        items: [{ amount: 25000.5 }, { amount: 24999.5 }]
      })
    expect(res.status).toBe(422)
    expect(await db.split_bill.count({ where: { order: order.id } })).toBe(0)
  })

  test('split-bill amount beyond INT4 range is rejected with 422, not a 500', async () => {
    const order = await makeUnpaidOrder(3000000000)
    const res = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: 3000000000 }] })
    expect(res.status).toBe(422)
    expect(await db.split_bill.count({ where: { order: order.id } })).toBe(0)
  })

  test('AR payment fractional amount is rejected', async () => {
    const ar = await db.accounts_receivable.create({
      store: store.id,
      orderId: arOrderId,
      totalAmount: 200000,
      paidAmount: 0,
      outstandingAmount: 200000,
      status: 'UNPAID'
    })
    const res = await request(app)
      .post(`/accounts-receivable/${ar.id}/pay`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 50000.5, paymentMethod: 'cash', reference: unique('monAR') })
    expect(res.status).toBe(422)
    expect(await db.ar_payment.count({ where: { arId: ar.id } })).toBe(0)
  })

  test('purchase payment fractional amount is rejected, not parseInt-truncated', async () => {
    const res = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        purchaseOrder: po.id,
        supplier: supplier.id,
        amount: 75000.9,
        paymentMethod: 'cash',
        reference: unique('monPP')
      })
    expect(res.status).toBe(422)
  })

  test('large exact integer payment still works end to end', async () => {
    const res = await postOrder({
      idempotencyKey: unique('monBig'),
      cashAmount: amountDue,
      changeAmount: 0
    })
    expect(res.status).toBe(201)
    const rows = await db.transaction.findAll({
      where: { order: res.body.data.id }
    })
    expect(rows.length).toBe(1)
    expect(Number(rows[0].cashReceived)).toBe(amountDue)
  })
})
