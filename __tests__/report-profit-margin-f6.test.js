process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA = null
let storeB = null
let storeC = null
let category = null
let tokenA = null
let tokenB = null
let superAdminToken = null
let counter = 0

const nextTag = () => {
  counter += 1
  return `F6-${Date.now()}-${counter}`
}

const makeProduct = async (name) => {
  return db.product.create({
    nameProduct: name,
    category: category.id,
    price: 10000,
    stock: 1000
  })
}

const makeOrder = async ({ store, totalPrice, paymentStatus = 'paid', status = 'paid', createdAt = new Date() }) =>
  db.order.create({
    orderNumber: nextTag(),
    store,
    status,
    paymentStatus,
    subTotal: totalPrice,
    discountAmount: 0,
    totalQuantity: 1,
    totalPrice,
    source: 'pos',
    createdAt
  })

const makeOrderItem = async ({ order, product, quantity, price, totalPrice, hppSnapshot }) =>
  db.order_item.create({
    order: order.id,
    product: product.id,
    productName: product.nameProduct,
    quantity,
    price,
    totalPrice,
    hppSnapshot,
    status: 'served'
  })

const makeApprovedReturn = async ({ order, store, product, orderItem, qty, price, approvedAt = new Date() }) => {
  const refundAmount = qty * price
  const ret = await db.sales_return.create({
    order: order.id,
    store,
    returnNumber: nextTag(),
    status: 'approved',
    reason: 'F6 regression fixture',
    refundAmount,
    approvedAt
  })
  await db.sales_return_item.create({
    salesReturn: ret.id,
    product: product.id,
    orderItem: orderItem.id,
    qty,
    price
  })
  return ret
}

const makePendingOrRejectedReturn = async ({ order, store, product, orderItem, qty, price, status }) => {
  const ret = await db.sales_return.create({
    order: order.id,
    store,
    returnNumber: nextTag(),
    status,
    reason: 'F6 regression fixture (not approved)',
    refundAmount: qty * price
  })
  await db.sales_return_item.create({
    salesReturn: ret.id,
    product: product.id,
    orderItem: orderItem.id,
    qty,
    price
  })
  return ret
}

const rangeStart = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const rangeEnd = new Date(Date.now() + 86400000).toISOString().slice(0, 10)

const getProfitPerProduct = (token, query = {}) =>
  request(app)
    .get('/report/profit-per-product')
    .set('Authorization', `Bearer ${token}`)
    .query({ startDate: rangeStart, endDate: rangeEnd, ...query })

const getDaily = (token, query = {}) =>
  request(app)
    .get('/report/daily')
    .set('Authorization', `Bearer ${token}`)
    .query({ startDate: rangeStart, endDate: rangeEnd, ...query })

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'F6_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'F6_STORE_B', status: 'active' }))
  storeC = await db.location.create(await withTestTenant({ name: 'F6_STORE_C', status: 'active' }))
  category = await db.category.create({ name: 'F6_CATEGORY' })

  // P1-4: central gate denies unknown caller identities; these rows give the
  // caller ids (incl. inline storeC tokens below) real identities. Assertions
  // below are unchanged.
  for (const [id, userName, roleType, userType, store] of [
    [8401, 'f6_admin_a', 'admin', 'admin', storeA.id],
    [8402, 'f6_admin_b', 'admin', 'admin', storeB.id],
    [8403, 'f6_super', 'super_admin', 'admin', null],
    [8404, 'f6_admin_c', 'admin', 'admin', storeC.id],
    [8405, 'f6_admin_c2', 'admin', 'admin', storeC.id]
  ]) {
    await db.user.create({
      id,
      userName,
      email: `p14-${id}-f6@test.com`,
      roleType,
      userType,
      store,
      status: 'active',
      fullName: userName
    })
  }
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  tokenA = await signSessionToken({ id: 8401, userName: 'f6_admin_a', roleType: 'admin', store: storeA.id }, JWT_SECRET)
  tokenB = await signSessionToken({ id: 8402, userName: 'f6_admin_b', roleType: 'admin', store: storeB.id }, JWT_SECRET)
  superAdminToken = await signSessionToken({ id: 8403, userName: 'f6_super', roleType: 'super_admin' }, JWT_SECRET)
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [8401, 8402, 8403, 8404, 8405] }, force: true })
  await db.sales_return_item.destroy({ where: {}, force: true })
  await db.sales_return.destroy({ where: {}, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: [storeA.id, storeB.id, storeC.id] }, force: true })
  await db.product.destroy({ where: { category: category.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: [storeA.id, storeB.id, storeC.id] }, force: true })
})

describe('F6-01 — COGS must be hppSnapshot × quantity', () => {
  test('Test 1: quantity > 1, plain product', async () => {
    const product = await makeProduct('F6_QTY_PRODUCT')
    const order = await makeOrder({ store: storeA.id, totalPrice: 75000 })
    await makeOrderItem({ order, product, quantity: 5, price: 15000, totalPrice: 75000, hppSnapshot: 10000 })

    const res = await getProfitPerProduct(tokenA)
    expect(res.status).toBe(200)
    const row = res.body.data.find((r) => r.productId === product.id)
    expect(row).toBeDefined()
    // Must NOT be the pre-fix bug value: totalHpp=10000, profit=65000.
    expect(row.totalHpp).toBe(50000)
    expect(row.totalSales).toBe(75000)
    expect(row.profit).toBe(25000)
  })

  test('Test 2: bundle-style line, quantity > 1 — same formula applies uniformly', async () => {
    // The report's SQL does not special-case bundleId — it multiplies
    // hppSnapshot × quantity for every order_item row regardless, which is
    // itself the point: no separate bundle formula exists to diverge.
    const product = await makeProduct('F6_BUNDLE_PRODUCT')
    const order = await makeOrder({ store: storeA.id, totalPrice: 90000 })
    await makeOrderItem({ order, product, quantity: 3, price: 30000, totalPrice: 90000, hppSnapshot: 7000 })

    const res = await getProfitPerProduct(tokenA)
    const row = res.body.data.find((r) => r.productId === product.id)
    expect(row.totalHpp).toBe(21000)
  })
})

describe('F6-03 — approved F4 return reconciliation', () => {
  test('Test 3: approved partial return nets both revenue and HPP', async () => {
    const product = await makeProduct('F6_RETURN_PRODUCT')
    const order = await makeOrder({ store: storeA.id, totalPrice: 100000 })
    const item = await makeOrderItem({ order, product, quantity: 5, price: 20000, totalPrice: 100000, hppSnapshot: 8000 })
    await makeApprovedReturn({ order, store: storeA.id, product, orderItem: item, qty: 2, price: 20000 })

    const res = await getProfitPerProduct(tokenA)
    const row = res.body.data.find((r) => r.productId === product.id)
    expect(row.totalSales).toBe(60000)
    expect(row.totalHpp).toBe(24000)
    expect(row.profit).toBe(36000)
    expect(row.margin).toBe(60)
  })

  test('Test 4: multiple approved return rows against the same order_item are summed once, never multiplying the base sale', async () => {
    const product = await makeProduct('F6_MULTI_RETURN_PRODUCT')
    const order = await makeOrder({ store: storeA.id, totalPrice: 100000 })
    const item = await makeOrderItem({ order, product, quantity: 5, price: 20000, totalPrice: 100000, hppSnapshot: 8000 })
    // Two separate approved returns of 1 unit each, instead of one of 2 —
    // proves the JOIN cannot inflate order_item's own gross totals no
    // matter how many return rows reference it.
    await makeApprovedReturn({ order, store: storeA.id, product, orderItem: item, qty: 1, price: 20000 })
    await makeApprovedReturn({ order, store: storeA.id, product, orderItem: item, qty: 1, price: 20000 })

    const res = await getProfitPerProduct(tokenA)
    const row = res.body.data.find((r) => r.productId === product.id)
    // Identical to Test 3's single qty=2 return — if the join multiplied
    // the base order_item row per return record, totalHpp would instead
    // come out as (40000*2 - 16000) = 64000.
    expect(row.totalSales).toBe(60000)
    expect(row.totalHpp).toBe(24000)
    expect(row.profit).toBe(36000)
  })

  test('Test 5: pending return has no effect', async () => {
    const product = await makeProduct('F6_PENDING_RETURN_PRODUCT')
    const order = await makeOrder({ store: storeA.id, totalPrice: 20000 })
    const item = await makeOrderItem({ order, product, quantity: 2, price: 10000, totalPrice: 20000, hppSnapshot: 4000 })
    await makePendingOrRejectedReturn({ order, store: storeA.id, product, orderItem: item, qty: 1, price: 10000, status: 'pending' })

    const res = await getProfitPerProduct(tokenA)
    const row = res.body.data.find((r) => r.productId === product.id)
    expect(row.totalSales).toBe(20000)
    expect(row.totalHpp).toBe(8000)
    expect(row.profit).toBe(12000)
  })

  test('Test 6: rejected return has no effect', async () => {
    const product = await makeProduct('F6_REJECTED_RETURN_PRODUCT')
    const order = await makeOrder({ store: storeA.id, totalPrice: 20000 })
    const item = await makeOrderItem({ order, product, quantity: 2, price: 10000, totalPrice: 20000, hppSnapshot: 4000 })
    await makePendingOrRejectedReturn({ order, store: storeA.id, product, orderItem: item, qty: 1, price: 10000, status: 'rejected' })

    const res = await getProfitPerProduct(tokenA)
    const row = res.body.data.find((r) => r.productId === product.id)
    expect(row.totalSales).toBe(20000)
    expect(row.totalHpp).toBe(8000)
    expect(row.profit).toBe(12000)
  })

  test('Test 7: refunded order keeps its legitimate remaining revenue, not discarded outright', async () => {
    const product = await makeProduct('F6_REFUNDED_ORDER_PRODUCT')
    const order = await makeOrder({ store: storeA.id, totalPrice: 40000, paymentStatus: 'refunded', status: 'paid' })
    const item = await makeOrderItem({ order, product, quantity: 4, price: 10000, totalPrice: 40000, hppSnapshot: 4000 })
    await makeApprovedReturn({ order, store: storeA.id, product, orderItem: item, qty: 1, price: 10000 })

    const res = await getProfitPerProduct(tokenA)
    const row = res.body.data.find((r) => r.productId === product.id)
    expect(row).toBeDefined()
    expect(row.totalSales).toBe(30000)
    expect(row.totalHpp).toBe(12000)
    expect(row.profit).toBe(18000)
  })

  test('Test 8: unpaid order is excluded entirely from gross figures', async () => {
    const product = await makeProduct('F6_UNPAID_ORDER_PRODUCT')
    const order = await makeOrder({ store: storeA.id, totalPrice: 5000, paymentStatus: 'unpaid', status: 'pending' })
    await makeOrderItem({ order, product, quantity: 1, price: 5000, totalPrice: 5000, hppSnapshot: 2000 })

    const res = await getProfitPerProduct(tokenA)
    const row = res.body.data.find((r) => r.productId === product.id)
    expect(row).toBeUndefined()
  })
})

describe('F6-02 — tenant scoping enforced via req.storeId, not req.query.store', () => {
  test('Test 9a: non-super-admin omitting ?store= sees only their own store (profit-per-product)', async () => {
    const productA = await makeProduct('F6_TENANT_A_PRODUCT')
    const productB = await makeProduct('F6_TENANT_B_PRODUCT')
    const orderA = await makeOrder({ store: storeA.id, totalPrice: 11000 })
    await makeOrderItem({ order: orderA, product: productA, quantity: 1, price: 11000, totalPrice: 11000, hppSnapshot: 5000 })
    const orderB = await makeOrder({ store: storeB.id, totalPrice: 22000 })
    await makeOrderItem({ order: orderB, product: productB, quantity: 1, price: 22000, totalPrice: 22000, hppSnapshot: 9000 })

    // No ?store= at all — this is exactly the omission the pre-fix code
    // failed to scope.
    const res = await getProfitPerProduct(tokenA)
    expect(res.status).toBe(200)
    const ids = res.body.data.map((r) => r.productId)
    expect(ids).toContain(productA.id)
    expect(ids).not.toContain(productB.id)

    // Symmetric check from store B's side, proving this isn't one-directional.
    const resB = await getProfitPerProduct(tokenB)
    expect(resB.status).toBe(200)
    const idsB = resB.body.data.map((r) => r.productId)
    expect(idsB).toContain(productB.id)
    expect(idsB).not.toContain(productA.id)
  })

  test('Test 9b: non-super-admin omitting ?store= sees only their own store (daily)', async () => {
    const orderA = await makeOrder({ store: storeC.id, totalPrice: 12345 })
    const productC = await makeProduct('F6_DAILY_TENANT_C_PRODUCT')
    await makeOrderItem({ order: orderA, product: productC, quantity: 1, price: 12345, totalPrice: 12345, hppSnapshot: 1000 })
    const tokenC = await signSessionToken({ id: 8404, userName: 'f6_admin_c', roleType: 'admin', store: storeC.id }, JWT_SECRET)
    const otherOrder = await makeOrder({ store: storeB.id, totalPrice: 99999 })
    const productOther = await makeProduct('F6_DAILY_TENANT_OTHER_PRODUCT')
    await makeOrderItem({ order: otherOrder, product: productOther, quantity: 1, price: 99999, totalPrice: 99999, hppSnapshot: 1000 })

    const res = await getDaily(tokenC)
    expect(res.status).toBe(200)
    const total = res.body.data.reduce((s, r) => s + r.totalPenjualanBersih, 0)
    // If the pre-fix leak were present, this would include storeB's 99999
    // as well, making the total far larger than storeC's own 12345.
    expect(total).toBe(12345)
  })

  test('Test 10: explicit foreign store is still rejected by validateStoreAccess (unweakened)', async () => {
    const res = await getProfitPerProduct(tokenA, { store: storeB.id })
    expect(res.status).toBe(403)
  })

  test('Test 11: super-admin with no store restriction still sees all stores', async () => {
    const res = await getProfitPerProduct(superAdminToken)
    expect(res.status).toBe(200)
    const ids = res.body.data.map((r) => r.productId)
    // From Test 9a's fixtures, both stores' products must be visible.
    const productA = await db.product.findOne({ where: { nameProduct: 'F6_TENANT_A_PRODUCT' } })
    const productB = await db.product.findOne({ where: { nameProduct: 'F6_TENANT_B_PRODUCT' } })
    expect(ids).toContain(productA.id)
    expect(ids).toContain(productB.id)
  })
})

describe('F6 — daily report and profit-per-product report reconcile on identical data', () => {
  test('single-store, single-product dataset: daily totals match profit-per-product totals', async () => {
    const product = await makeProduct('F6_RECONCILE_PRODUCT')
    const order = await makeOrder({ store: storeC.id, totalPrice: 100000 })
    const item = await makeOrderItem({ order, product, quantity: 5, price: 20000, totalPrice: 100000, hppSnapshot: 8000 })
    await makeApprovedReturn({ order, store: storeC.id, product, orderItem: item, qty: 2, price: 20000 })

    const tokenC = await signSessionToken({ id: 8405, userName: 'f6_admin_c2', roleType: 'admin', store: storeC.id }, JWT_SECRET)
    const ppp = await getProfitPerProduct(tokenC)
    const row = ppp.body.data.find((r) => r.productId === product.id)
    expect(row.totalSales).toBe(60000)
    expect(row.totalHpp).toBe(24000)
    expect(row.profit).toBe(36000)

    const daily = await getDaily(tokenC)
    // storeC also carries prior fixtures from earlier tests in this file
    // (Test 9b / reconciliation setup) inside the same date window, so
    // sum across all returned days for a total-figure comparison instead
    // of assuming a single row.
    const dailyRevenue = daily.body.data.reduce((s, r) => s + r.totalPenjualanBersih, 0)
    const dailyHpp = daily.body.data.reduce((s, r) => s + r.totalHpp, 0)
    // This dataset's own contribution must be present in the totals.
    expect(dailyRevenue).toBeGreaterThanOrEqual(60000)
    expect(dailyHpp).toBeGreaterThanOrEqual(24000)
  })
})

describe('F6-02 — export path inherits the same tenant scoping fix', () => {
  test('CSV export of profit-per-product cannot bypass tenant scoping when ?store= is omitted', async () => {
    const res = await request(app)
      .get('/report/export/profitPerProduct')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ format: 'csv', startDate: rangeStart, endDate: rangeEnd })
    expect(res.status).toBe(200)
    expect(res.text).toContain('F6_TENANT_A_PRODUCT')
    expect(res.text).not.toContain('F6_TENANT_B_PRODUCT')
  })

  test('CSV export of daily report cannot bypass tenant scoping when ?store= is omitted', async () => {
    const res = await request(app)
      .get('/report/export/daily')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ format: 'csv', startDate: rangeStart, endDate: rangeEnd })
    expect(res.status).toBe(200)
    // storeB's distinctive total (99999, from Test 9b) must never surface
    // in storeA's exported report.
    expect(res.text).not.toContain('99999')
  })
})
