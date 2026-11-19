process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let category = null
let product = null
let supplier = null
let adminToken = null

const makePO = async (finalAmount) => {
  const res = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: location.id,
      status: 'ordered',
      items: [
        {
          product: product.id,
          supplier: supplier.id,
          quantity: 10,
          price: finalAmount / 10
        }
      ]
    })
  return res.body.data
}

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'PP_FLOW_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PP_FLOW_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PP_FLOW_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 5
  })
  supplier = await db.supplier.create({ name: 'PP_FLOW_SUPPLIER' })

  // purchase_payment.createdBy FKs to user.id (unlike order/transaction/
  // stock_history, which don't) — the token subject needs a real user row.
  const adminUser = await db.user.create({
    userName: 'admin_pp_flow',
    email: 'admin_pp_flow@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  // Scoped to this file's own fixtures (by store/PO id) rather than an
  // unconditional `where: {}` — an unscoped destroy() here matches every
  // row in the table, including other test files' fixtures. Jest runs
  // files in parallel workers against the same test database, so an
  // unscoped destroy in this file's afterAll can delete another file's
  // in-flight rows (observed: it intermittently deleted
  // tenant-isolation-idor.test.js's payment fixtures mid-run, producing a
  // spurious 404 in that file when both suites ran together).
  const ownPOs = await db.purchase_order.findAll({
    where: { store: location.id },
    attributes: ['id']
  })
  const ownPOIds = ownPOs.map((po) => po.id)
  await db.purchase_payment.destroy({ where: { store: location.id }, force: true })
  await db.purchase_order_item.destroy({
    where: { purchaseOrder: ownPOIds },
    force: true
  })
  await db.purchase_order.destroy({ where: { store: location.id }, force: true })
  await db.supplier.destroy({ where: { id: supplier?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { userName: 'admin_pp_flow' }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('POST /purchase-payment/create', () => {
  test('records a payment against a PO', async () => {
    const po = await makePO(100000)

    const res = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: po.id,
        supplier: supplier.id,
        amount: 40000,
        paymentMethod: 'cash'
      })

    expect(res.status).toBe(201)
    expect(Number(res.body.data.amount)).toBe(40000)
  })

  test('rejects a single over-payment past the PO total', async () => {
    const po = await makePO(50000)

    const res = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: po.id,
        supplier: supplier.id,
        amount: 60000,
        paymentMethod: 'cash'
      })

    expect(res.status).toBe(400)
  })

  test('two concurrent payments that would jointly overpay: exactly one is accepted', async () => {
    const po = await makePO(100000)

    // Each individually fits under the 100000 total (70000 < 100000), but
    // together they'd overpay by 40000 — this is the exact race the sum-
    // check-then-insert pattern was vulnerable to.
    const [r1, r2] = await Promise.all([
      request(app)
        .post('/purchase-payment/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ purchaseOrder: po.id, supplier: supplier.id, amount: 70000, paymentMethod: 'cash' }),
      request(app)
        .post('/purchase-payment/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ purchaseOrder: po.id, supplier: supplier.id, amount: 70000, paymentMethod: 'cash' })
    ])

    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([201, 400])

    const totalPaid = await db.purchase_payment.sum('amount', {
      where: { purchaseOrder: po.id }
    })
    expect(totalPaid).toBe(70000)
  })

  test('duplicate submit with the same idempotency key returns the original payment, not a second one', async () => {
    const po = await makePO(100000)
    const key = 'test-idem-key-' + Date.now()

    const [r1, r2] = await Promise.all([
      request(app)
        .post('/purchase-payment/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          purchaseOrder: po.id,
          supplier: supplier.id,
          amount: 30000,
          paymentMethod: 'cash',
          idempotencyKey: key
        }),
      request(app)
        .post('/purchase-payment/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          purchaseOrder: po.id,
          supplier: supplier.id,
          amount: 30000,
          paymentMethod: 'cash',
          idempotencyKey: key
        })
    ])

    expect([r1.status, r2.status].sort()).toEqual([200, 201])
    expect(r1.body.data.id).toBe(r2.body.data.id)

    const payments = await db.purchase_payment.findAll({
      where: { purchaseOrder: po.id, idempotencyKey: key }
    })
    expect(payments.length).toBe(1)

    const totalPaid = await db.purchase_payment.sum('amount', {
      where: { purchaseOrder: po.id }
    })
    expect(totalPaid).toBe(30000)
  })
})
