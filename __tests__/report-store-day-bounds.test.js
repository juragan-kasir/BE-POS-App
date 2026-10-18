process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const cashFlowDef = require('../api/service/reportDefs/cashFlow')
const profitPerProductDef = require('../api/service/reportDefs/profitPerProduct')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const SUFFIX = Date.now()
const TZ = 'Asia/Jakarta'

// A report day window must be the STORE-LOCAL day: an order written at
// 00:30 WIB belongs to that WIB day even though its UTC date is still the
// previous day. The old window math used the server machine clock
// (new Date(...).setHours(23, 59, 59, 999)), so between 00:00-07:00 WIB
// these instants fell outside every window on a WIB machine, and on a
// UTC machine the same gap hits the store-local month/day start.
const localDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date())
const earlyInstant = new Date(`${localDay}T00:30:00+07:00`)

let store = null
let adminToken = null
let category = null
let product = null
let order = null
let supplier = null
let purchaseOrder = null

beforeAll(async () => {
  store = await db.location.create({ name: `SDB_STORE_${SUFFIX}`, status: 'active' })
  await db.user.create({
    id: 7203,
    userName: `sdb_admin_${SUFFIX}`,
    email: `sdb-7203-${SUFFIX}@test.com`,
    roleType: 'admin',
    userType: 'user',
    store: store.id,
    status: 'active',
    fullName: `sdb_admin_${SUFFIX}`
  })
  adminToken = await signSessionToken(
    { id: 7203, userName: `sdb_admin_${SUFFIX}`, roleType: 'admin', store: store.id },
    JWT_SECRET
  )

  category = await db.category.create({ name: `SDB_CATEGORY_${SUFFIX}` })
  product = await db.product.create({
    nameProduct: `SDB_PRODUCT_${SUFFIX}`,
    category: category.id,
    price: 111000,
    stock: 10
  })
  order = await db.order.create({
    orderNumber: `SDB-ORD-${SUFFIX}`,
    store: store.id,
    status: 'paid',
    paymentStatus: 'paid',
    subTotal: 111000,
    discountAmount: 0,
    totalQuantity: 1,
    totalPrice: 111000,
    source: 'pos',
    createdAt: earlyInstant
  })
  await db.transaction.create({ order: order.id, typePayment: 'QRIS', amount: 111000 })
  await db.order_item.create({
    order: order.id,
    product: product.id,
    productName: product.nameProduct,
    quantity: 1,
    price: 111000,
    totalPrice: 111000,
    hppSnapshot: 41000,
    status: 'served'
  })

  // A purchase order written just after midnight on the first store-local
  // day of the current month: same class of gap for the supplier-score
  // monthly window (01:00-07:00 WIB on day 1 falls before the old UTC-based
  // window start on a UTC machine).
  supplier = await db.supplier.create({ name: `SDB_SUPPLIER_${SUFFIX}` })
  const monthFirst = `${localDay.slice(0, 7)}-01`
  const earlyMonthInstant = new Date(`${monthFirst}T00:30:00+07:00`)
  purchaseOrder = await db.purchase_order.create({
    orderNumber: `SDB-PO-${SUFFIX}`,
    store: store.id,
    supplier: supplier.id,
    status: 'ordered',
    orderDate: earlyMonthInstant,
    totalAmount: 50000,
    finalAmount: 50000
  })
  await db.purchase_order_item.create({
    purchaseOrder: purchaseOrder.id,
    supplier: supplier.id,
    quantity: 1,
    price: 50000,
    receivedQuantity: 0
  })
})

afterAll(async () => {
  if (supplier?.id) await db.supplier_score.destroy({ where: { supplierId: supplier.id }, force: true })
  if (purchaseOrder?.id) {
    await db.purchase_order_item.destroy({ where: { purchaseOrder: purchaseOrder.id }, force: true })
    await db.purchase_order.destroy({ where: { id: purchaseOrder.id }, force: true })
  }
  if (supplier?.id) await db.supplier.destroy({ where: { id: supplier.id }, force: true })
  if (order?.id) {
    await db.order_item.destroy({ where: { order: order.id }, force: true })
    await db.transaction.destroy({ where: { order: order.id }, force: true })
    await db.order.destroy({ where: { id: order.id }, force: true })
  }
  if (product?.id) await db.product.destroy({ where: { id: product.id }, force: true })
  if (category?.id) await db.category.destroy({ where: { id: category.id }, force: true })
  await db.user.destroy({ where: { id: [7203] }, force: true })
  if (store?.id) await db.location.destroy({ where: { id: store.id }, force: true })
})

const reqFor = () => ({
  storeId: store.id,
  query: { startDate: localDay, endDate: localDay },
  user: { roleType: 'admin', store: store.id }
})

describe('report day windows follow the store timezone', () => {
  test('GET /report/cash-flow counts an order written after WIB midnight in that same WIB day', async () => {
    const res = await request(app)
      .get('/report/cash-flow')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ store: store.id, startDate: localDay, endDate: localDay })
    expect(res.status).toBe(200)
    expect(res.body.data.penerimaanQris).toBe(111000)
  })

  test('cash-flow export definition counts the same WIB-midnight order', async () => {
    const { rows } = await cashFlowDef.getData(reqFor())
    const byKeterangan = Object.fromEntries(rows.map((r) => [r.keterangan, r.nominal]))
    expect(byKeterangan['Penerimaan QRIS']).toBe(111000)
  })

  test('profit-per-product definition counts the same WIB-midnight order', async () => {
    const { rows } = await profitPerProductDef.getData(reqFor())
    const row = rows.find((r) => r.productId === product.id)
    expect(row).toBeDefined()
    expect(row.totalSales).toBe(111000)
  })

  test('supplier score monthly window includes an order written after WIB month-start midnight', async () => {
    const res = await request(app)
      .post('/supplier-performance/scores/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ supplierId: supplier.id, period: 'monthly' })
    expect(res.status).toBe(200)
    expect(res.body.calculation.totalOrders).toBe(1)
  })
})
