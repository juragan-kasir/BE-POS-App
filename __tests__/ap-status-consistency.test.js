process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 5 — F21-07.
//
// getBySupplier's PO lookup (`poWhere = { id: { [Op.in]: poIds } }`) has no
// status filter at all, while apDashboard's
// (`poWhere = { status: { [Op.notIn]: ['cancelled', 'draft'] } }`)
// deliberately excludes draft and cancelled orders. Both compute the same
// business concept — the FE literally labels getBySupplier's `balance` as
// "Saldo Utang" (outstanding debt) on DetailSupplier.jsx, with a Pay button
// gated on `balance > 0` — so a draft PO (not yet a real order) or a
// cancelled PO (voided) inflating that balance is a real bug, not two
// intentionally different concepts.

let storeA = null
let category = null
let product = null
let supplierA = null
let supplierB = null
let adminA = null
let tokenA = null
let poCounter = 0

const nextPoNumber = () => {
  poCounter += 1
  return `AP_STATUS_PO_${Date.now()}_${poCounter}`
}

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'AP_STATUS_STORE_A', status: 'active' }))
  category = await db.category.create({ name: 'AP_STATUS_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'AP_STATUS_PRODUCT',
    category: category.id,
    price: 8000,
    stock: 0
  })
  supplierA = await db.supplier.create({ name: 'AP_STATUS_SUPPLIER_A' })
  supplierB = await db.supplier.create({ name: 'AP_STATUS_SUPPLIER_B' })

  adminA = await db.user.create({
    userName: 'admin_ap_status_a',
    email: 'admin_ap_status_a@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active'
  })
  tokenA = await signSessionToken(
    { id: adminA.id, userName: adminA.userName, roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.purchase_payment.destroy({ where: { store: storeA.id }, force: true })
  const ownPOs = await db.purchase_order.findAll({
    where: { store: storeA.id },
    attributes: ['id']
  })
  const ownPOIds = ownPOs.map((po) => po.id)
  await db.purchase_order_item.destroy({ where: { purchaseOrder: ownPOIds }, force: true })
  await db.purchase_order.destroy({ where: { store: storeA.id }, force: true })
  await db.supplier.destroy({ where: { id: [supplierA?.id, supplierB?.id] }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: adminA?.id }, force: true })
  await db.location.destroy({ where: { id: storeA?.id }, force: true })
})

// Direct DB creation (not the HTTP create endpoint) — draft/cancelled are
// terminal/initial statuses that create's own validation may not accept as
// a direct input, and this batch only needs the resulting rows to exist,
// not to exercise PO creation itself (out of scope per the no-go list).
const makePO = (supplier, status, finalAmount) =>
  db.purchase_order.create({
    store: storeA.id,
    orderNumber: nextPoNumber(),
    status,
    finalAmount,
    totalAmount: finalAmount
  }).then(async (po) => {
    await db.purchase_order_item.create({
      purchaseOrder: po.id,
      product: product.id,
      supplier: supplier.id,
      quantity: 1,
      price: finalAmount,
      total: finalAmount
    })
    return po
  })

describe('F21-07 — getBySupplier excludes draft/cancelled POs, matching apDashboard', () => {
  let ordered = null

  beforeAll(async () => {
    ordered = await makePO(supplierA, 'ordered', 100000)
    await makePO(supplierA, 'draft', 50000)
    await makePO(supplierA, 'cancelled', 30000)
  })

  test('getBySupplier balance reflects only the real (non-draft, non-cancelled) order', async () => {
    const res = await request(app)
      .get(`/purchase-payment/by-supplier/${supplierA.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)
    expect(res.body.data.summary.totalOrdered).toBe(100000)
    expect(res.body.data.summary.balance).toBe(100000)
  })

  test('apDashboard agrees with getBySupplier for the same supplier', async () => {
    const dashRes = await request(app)
      .get('/purchase-payment/ap-dashboard')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(dashRes.status).toBe(200)

    const supplierEntry = dashRes.body.data.suppliers.find(
      (s) => s.supplierId === supplierA.id
    )
    expect(supplierEntry).toBeDefined()
    expect(supplierEntry.outstanding).toBe(100000)

    const supplierRes = await request(app)
      .get(`/purchase-payment/by-supplier/${supplierA.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(supplierRes.body.data.summary.balance).toBe(supplierEntry.outstanding)
  })

  test('the draft and cancelled POs are excluded from the supplier\'s PO list too', async () => {
    const res = await request(app)
      .get(`/purchase-payment/by-supplier/${supplierA.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    const ids = res.body.data.purchaseOrders.map((po) => po.id)
    expect(ids).toEqual([ordered.id])
  })
})

describe('F21-07 — payment interaction is unaffected by the status fix', () => {
  test('unpaid liability: balance equals the full order amount', async () => {
    const po = await makePO(supplierA, 'ordered', 80000)

    const res = await request(app)
      .get(`/purchase-payment/by-supplier/${supplierA.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    const thisPo = res.body.data.purchaseOrders.find((p) => p.id === po.id)
    expect(thisPo).toBeDefined()
  })

  test('partially paid liability: balance reflects amount minus payment', async () => {
    const po = await makePO(supplierA, 'ordered', 100000)
    await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ purchaseOrder: po.id, supplier: supplierA.id, amount: 40000, paymentMethod: 'cash' })

    const res = await request(app)
      .get(`/purchase-payment/by-supplier/${supplierA.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    const thisPo = res.body.data.purchaseOrders.find((p) => p.id === po.id)
    const paidForThisPo = (thisPo.payments || []).reduce((s, p) => s + Number(p.amount), 0)
    expect(paidForThisPo).toBe(40000)
  })

  test('fully paid liability: PO no longer appears in apDashboard\'s outstanding list', async () => {
    const po = await makePO(supplierA, 'ordered', 25000)
    await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ purchaseOrder: po.id, supplier: supplierA.id, amount: 25000, paymentMethod: 'cash' })

    const res = await request(app)
      .get('/purchase-payment/ap-dashboard')
      .set('Authorization', `Bearer ${tokenA}`)

    const outstandingIds = res.body.data.outstandingPOs.map((o) => o.id)
    expect(outstandingIds).not.toContain(po.id)
  })
})

describe('F21-07 — supplier and store isolation preserved', () => {
  test('supplier isolation: Supplier B\'s orders never appear in Supplier A\'s balance', async () => {
    await makePO(supplierB, 'ordered', 999000)

    const res = await request(app)
      .get(`/purchase-payment/by-supplier/${supplierA.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    const ids = res.body.data.purchaseOrders.map((po) => po.id)
    const supplierBPOs = await db.purchase_order_item.findAll({
      where: { supplier: supplierB.id },
      attributes: ['purchaseOrder']
    })
    const supplierBPOIds = supplierBPOs.map((r) => r.purchaseOrder)
    supplierBPOIds.forEach((id) => expect(ids).not.toContain(id))
  })

  test('store isolation: getBySupplier stays scoped to the caller\'s own store', async () => {
    const res = await request(app)
      .get(`/purchase-payment/by-supplier/${supplierA.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)
    res.body.data.purchaseOrders.forEach((po) => expect(po.store).toBe(storeA.id))
  })
})
