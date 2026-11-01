process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// One store, one day:
//   A  paid                 subTotal 100000, tax 11000 → 111000; 2 × hpp 30000
//   B  partially refunded   subTotal  50000, tax  5500 →  55500; X hpp 20000, Y hpp 10000
//      approved return of Y (line 20000, refundAmount 22200)
//   C  'partial' without a return (unfinished split bill) → not a sale
//   D  paid but cancelled → not a sale
//   expense 5000
// Expected: gross 166500, refunds 22200, revenue 144300,
//   net sales 150000 − 20000 = 130000, HPP 60000 + 30000 − 10000 = 80000,
//   gross profit 50000, net profit 45000, margin 34.6 %.

let store = null
let category = null
let adminToken = null
let superToken = null
const stamp = `${Date.now()}`
const ids = { users: [8601, 8602], orders: [], items: [], returns: [], expenses: [], products: [] }
let seq = 0
const tag = () => `RFN-${stamp}-${(seq += 1)}`

const today = new Date()
const rangeStart = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const rangeEnd = new Date(Date.now() + 86400000).toISOString().slice(0, 10)

const makeOrder = async (fields) => {
  const row = await db.order.create({
    orderNumber: tag(),
    store: store.id,
    status: 'paid',
    paymentStatus: 'paid',
    discountAmount: 0,
    totalQuantity: 1,
    source: 'pos',
    createdAt: today,
    ...fields
  })
  ids.orders.push(row.id)
  return row
}

const makeItem = async (order, product, quantity, price, hppSnapshot) => {
  const row = await db.order_item.create({
    order: order.id,
    product: product.id,
    productName: product.nameProduct,
    quantity,
    price,
    totalPrice: quantity * price,
    hppSnapshot,
    status: 'served'
  })
  ids.items.push(row.id)
  return row
}

beforeAll(async () => {
  store = await db.location.create({ name: `RFN_STORE_${stamp}`, status: 'active' })
  category = await db.category.create({ name: `RFN_CATEGORY_${stamp}` })
  const product = await db.product.create({ nameProduct: `RFN_P_${stamp}`, category: category.id, price: 10000 })
  ids.products.push(product.id)

  for (const [id, userName, roleType, userStore] of [
    [8601, `rfn_admin_${stamp}`, 'admin', store.id],
    [8602, `rfn_super_${stamp}`, 'super_admin', null]
  ]) {
    await db.user.create({
      id,
      userName,
      email: `rfn-${id}-${stamp}@test.com`,
      roleType,
      userType: 'admin',
      store: userStore,
      status: 'active',
      fullName: userName
    })
  }
  adminToken = await signSessionToken(
    { id: 8601, userName: `rfn_admin_${stamp}`, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 8602, userName: `rfn_super_${stamp}`, roleType: 'super_admin' },
    JWT_SECRET
  )

  const a = await makeOrder({ subTotal: 100000, taxAmount: 11000, totalPrice: 111000, totalQuantity: 2 })
  await makeItem(a, product, 2, 50000, 30000)

  const b = await makeOrder({
    subTotal: 50000,
    taxAmount: 5500,
    totalPrice: 55500,
    totalQuantity: 2,
    paymentStatus: 'partial'
  })
  await makeItem(b, product, 1, 30000, 20000)
  const y = await makeItem(b, product, 1, 20000, 10000)
  const ret = await db.sales_return.create({
    order: b.id,
    store: store.id,
    returnNumber: tag(),
    status: 'approved',
    reason: 'report figures fixture',
    refundAmount: 22200,
    approvedAt: today
  })
  ids.returns.push(ret.id)
  await db.sales_return_item.create({
    salesReturn: ret.id,
    product: product.id,
    orderItem: y.id,
    qty: 1,
    price: 20000
  })

  const c = await makeOrder({
    subTotal: 90000,
    taxAmount: 9999,
    totalPrice: 99999,
    paymentStatus: 'partial',
    status: 'pending'
  })
  await makeItem(c, product, 1, 90000, 40000)

  const d = await makeOrder({ subTotal: 70000, taxAmount: 7700, totalPrice: 77700, status: 'cancelled' })
  await makeItem(d, product, 1, 70000, 35000)

  const expense = await db.expense.create({
    store: store.id,
    expenseNumber: tag(),
    amount: 5000,
    date: today,
    status: 'approved',
    isActive: true
  })
  ids.expenses.push(expense.id)
})

afterAll(async () => {
  await db.sales_return_item.destroy({ where: { salesReturn: ids.returns }, force: true })
  await db.sales_return.destroy({ where: { id: ids.returns }, force: true })
  await db.order_item.destroy({ where: { id: ids.items }, force: true })
  await db.order.destroy({ where: { id: ids.orders }, force: true })
  await db.expense.destroy({ where: { id: ids.expenses }, force: true })
  await db.product.destroy({ where: { id: ids.products }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('report figures count partially refunded sales and subtract refunds', () => {
  test('super admin dashboard: revenue net of refunds, real HPP in net profit', async () => {
    const res = await request(app)
      .get('/pos/dashboard/super-admin')
      .set('Authorization', `Bearer ${superToken}`)
      .query({ store: store.id, startDate: rangeStart, endDate: rangeEnd })
    expect(res.status).toBe(200)
    const s = res.body.data.summary
    expect(s.grossRevenue).toBe(166500)
    expect(s.refunds).toBe(22200)
    expect(s.revenue).toBe(144300)
    expect(s.orders).toBe(2)
    expect(s.netSales).toBe(130000)
    expect(s.cogs).toBe(80000)
    expect(s.grossProfit).toBe(50000)
    expect(s.netProfit).toBe(45000)
    expect(s.profitMargin).toBe(34.6)
    const row = res.body.data.storePerformance.find((p) => p.storeId === store.id)
    expect(row.revenue).toBe(144300)
    const trendTotal = res.body.data.kpiTrend.reduce((t, d) => t + d.revenue, 0)
    expect(trendTotal).toBe(144300)
  })

  test('store dashboard: the same figures', async () => {
    const res = await request(app)
      .get('/pos/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ startDate: rangeStart, endDate: rangeEnd })
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.grossSales).toBe(166500)
    expect(d.refunds).toBe(22200)
    expect(d.totalSales).toBe(144300)
    expect(d.totalOrders).toBe(2)
    expect(d.netProfit).toBe(45000)
    expect(d.profitMargin).toBe(34.6)
  })

  test('sales summary: totals, store row and chart all net of refunds', async () => {
    const res = await request(app)
      .get('/report/sales-summary')
      .set('Authorization', `Bearer ${superToken}`)
      .query({ store: store.id, startDate: rangeStart, endDate: rangeEnd })
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.grossSales).toBe(166500)
    expect(d.refunds).toBe(22200)
    expect(d.totalSales).toBe(144300)
    expect(d.totalOrders).toBe(2)
    expect(d.stores.find((r) => r.id === store.id).sales).toBe(144300)
    expect(d.salesChart.reduce((t, r) => t + Number(r.sales || 0), 0)).toBe(144300)
  })

  test('daily report: every column is filled', async () => {
    const res = await request(app)
      .get('/report/data/daily')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ startDate: rangeStart, endDate: rangeEnd })
    expect(res.status).toBe(200)
    const [row] = res.body.data.rows
    expect(row.date).toBeTruthy()
    expect(row.totalTransaksi).toBe(2)
    expect(row.totalPenjualanKotor).toBe(150000)
    expect(row.diskon).toBe(0)
    expect(row.pajak).toBe(16500)
    expect(row.serviceCharge).toBe(0)
    expect(row.totalPenjualanBersih).toBe(130000)
    expect(row.totalHpp).toBe(80000)
    expect(row.operationalExpense).toBe(5000)
    expect(row.netProfit).toBe(45000)
    for (const column of res.body.data.columns) {
      expect(row[column.key]).not.toBeUndefined()
    }
  })
})
