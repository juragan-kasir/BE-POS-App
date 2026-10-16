process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-PAY-2 regression (AR half): the server derives AR status from balances
// (UNPAID/PARTIAL/PAID in recordPayment). A client-provided status that
// contradicts the balances must be rejected, and financially effective ARs
// (payments exist) must not be deletable. Pristine UNPAID ARs remain
// manageable.

let store = null
let adminToken = null
let order = null
let product = null
let category = null
let openAR = null
let paidAR = null

async function makeAR({ totalAmount, paidAmount, status }) {
  const outstanding = totalAmount - paidAmount
  return db.accounts_receivable.create({
    store: store.id,
    orderId: order.id,
    totalAmount,
    paidAmount,
    outstandingAmount: outstanding,
    status
  })
}

beforeAll(async () => {
  store = await db.location.create({ name: `ARPAY_STORE_${Date.now()}`, status: 'active' })
  const adminUser = await db.user.create({
    userName: `admin_arpay_${Date.now()}`,
    email: `admin_arpay_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  category = await db.category.create({ name: `ARPAY_CAT_${Date.now()}` })
  product = await db.product.create({
    nameProduct: `ARPAY_PRODUCT_${Date.now()}`,
    category: category.id,
    price: 100000,
    stock: 10
  })
  await db.product_store_stock.create({
    product: product.id,
    store: store.id,
    stock: 10
  })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so this order setup exercises configured tax.
  await db.taxConfig.create({
    name: 'ARPAY_PPN',
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
      items: [{ product: product.id, quantity: 1, productName: 'arpay' }],
      paymentMethod: 'cash',
      cashierName: 'AR Cashier'
    }))
  if (orderRes.status !== 201) throw new Error('order setup failed')
  order = await db.order.findByPk(orderRes.body.data.id)
  openAR = await makeAR({ totalAmount: 100000, paidAmount: 0, status: 'UNPAID' })
  paidAR = await makeAR({ totalAmount: 100000, paidAmount: 100000, status: 'PAID' })
  await db.ar_payment.create({
    arId: paidAR.id,
    amount: 100000,
    paymentMethod: 'cash',
    reference: `arpay-ref-${Date.now()}`
  })
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
  await db.product_store_stock.destroy({ where: { store: store?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

function putAR(id, body) {
  return request(app)
    .put(`/accounts-receivable/${id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send(body)
}

describe('F-PAY-2 AR status and delete guards', () => {
  test('client cannot mark an unpaid AR as PAID', async () => {
    const res = await putAR(openAR.id, { status: 'PAID' })
    expect([400, 422]).toContain(res.status)
    const fresh = await db.accounts_receivable.findByPk(openAR.id)
    expect(fresh.status).toBe('UNPAID')
  })

  test('client cannot reopen a fully-paid AR to UNPAID', async () => {
    const res = await putAR(paidAR.id, { status: 'UNPAID' })
    expect([400, 422]).toContain(res.status)
    const fresh = await db.accounts_receivable.findByPk(paidAR.id)
    expect(fresh.status).toBe('PAID')
  })

  test('legitimate non-status update still works', async () => {
    // Restore the fixture: the earlier vulnerability probes intentionally
    // mutated openAR through the very hole under test.
    await db.accounts_receivable.update(
      { status: 'UNPAID', paidAmount: 0, outstandingAmount: 100000 },
      { where: { id: openAR.id } }
    )
    const res = await putAR(openAR.id, { notes: 'routine follow-up' })
    expect(res.status).toBe(200)
    const fresh = await db.accounts_receivable.findByPk(openAR.id)
    expect(fresh.notes).toBe('routine follow-up')
    expect(fresh.status).toBe('UNPAID')
  })

  test('AR with payments cannot be deleted', async () => {
    const res = await request(app)
      .delete(`/accounts-receivable/${paidAR.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect([400, 409]).toContain(res.status)
    expect(await db.accounts_receivable.findByPk(paidAR.id)).not.toBeNull()
    expect(await db.ar_payment.count({ where: { arId: paidAR.id } })).toBe(1)
  })

  test('pristine UNPAID AR with no payments can still be deleted', async () => {
    const pristine = await makeAR({ totalAmount: 50000, paidAmount: 0, status: 'UNPAID' })
    const res = await request(app)
      .delete(`/accounts-receivable/${pristine.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(await db.accounts_receivable.findByPk(pristine.id)).toBeNull()
  })
})
