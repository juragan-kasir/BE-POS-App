process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const crypto = require('crypto')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let adminTokenStore1 = null

let store1 = null
let store2 = null
let table1 = null
let table2 = null
let table2Store2 = null
let tableQty = null
let category = null
let product = null
let initialProductStock = 0
let store2Product = null
let store2ProductUnpaid = null
let store2BundleProduct = null
let store2Bundle = null
let store1BundleWithForeignComponent = null
let memberStore1 = null
let memberStore2 = null
const createdOrderIds = []
const directOrderIds = []

const makeDirectOrder = async (storeId, tableId, overrides = {}) => {
  const order = await db.order.create({
    orderNumber: `SEC-${crypto.randomBytes(6).toString('hex')}`,
    store: storeId,
    tableId,
    source: 'qr',
    status: 'pending',
    paymentStatus: 'unpaid',
    subTotal: 10000,
    totalPrice: 10000,
    publicToken: crypto.randomBytes(24).toString('hex'),
    ...overrides
  })
  directOrderIds.push(order.id)
  return order
}

// The cashier represents the trusted paid-transition authority: only an
// authenticated, authorized order-status change may turn a public QR order
// into a paid order (and with it run stock/ledger/accounting mutations).
const markOrderPaid = (token, body) =>
  request(app).put('/order/update-status').set('Authorization', `Bearer ${token}`).send(body)

const deepKeys = (value, acc = []) => {
  if (Array.isArray(value)) {
    value.forEach((v) => deepKeys(v, acc))
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      acc.push(key)
      deepKeys(value[key], acc)
    }
  }
  return acc
}

beforeAll(async () => {
  store1 = await db.location.create({ name: 'SEC_STORE_1', status: 'active' })
  store2 = await db.location.create({ name: 'SEC_STORE_2', status: 'active' })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed rates for
  // both stores so QR setup assertions exercise configured tax.
  for (const s of [store1, store2]) {
    await db.taxConfig.create({
      name: `SEC_PPN_${s.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: s.id
    })
  }
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 9402,
    userName: 'sec_admin_s1',
    email: 'p14-9402-customer-order-security@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store1.id,
    status: 'active',
    fullName: 'sec_admin_s1'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminTokenStore1 = await signSessionToken(
    { id: 9402, userName: 'sec_admin_s1', roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  // DR-04: settling via update-status requires drawer attribution — seed
  // the open register the paid transitions resolve at payment time.
  // (Placed after the opener user row: cashRegister.user is FK-enforced.)
  await db.cashRegister.destroy({ where: { store: store1.id, status: 'open' }, force: true })
  await db.cashRegister.create({
    store: store1.id,
    user: 9402,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })

  table1 = await db.table.create({ store: store1.id, name: 'SEC_TABLE_1' })
  table2 = await db.table.create({ store: store1.id, name: 'SEC_TABLE_2' })
  tableQty = await db.table.create({ store: store1.id, name: 'SEC_TABLE_QTY' })
  table2Store2 = await db.table.create({ store: store2.id, name: 'SEC_TABLE_2_S2' })

  category = await db.category.create({ name: 'SEC_CATEGORY' })

  product = await db.product.create({
    nameProduct: 'SEC_PRODUCT',
    category: category.id,
    price: 12000,
    stock: 15,
    costPrice: 5000,
    minStock: 10,
    hppPerPorsi: 5.5,
    foodCostPersen: 41.67,
    marginPersen: 58.33,
    createdBy: 1,
    modifiedBy: 2,
    isAvailable: true,
    options: [{ name: 'Level', options: [{ name: 'Level 1', price: 0 }] }],
    modifiers: [{ name: 'Tambah Keju', price: 2000 }],
    composition: ['Beras', 'Ayam'],
    estimationTime: 10
  })
  initialProductStock = product.stock
  await db.product_store_stock.create({
    product: product.id,
    store: store1.id,
    stock: product.stock
  })

  // Store-2-owned products, each dedicated to ONE exploitable payload so the
  // tests never share mutable stock state (a paid cross-store attempt
  // auto-creates an empty product_store_stock row for the claimed store,
  // which would otherwise leak "Tersedia: 0" and mask the tenancy claim).
  store2Product = await db.product.create({
    nameProduct: 'SEC_PRODUCT_S2',
    category: category.id,
    price: 30000,
    stock: 8,
    isAvailable: true
  })
  await db.product_store.create({ product: store2Product.id, store: store2.id })
  await db.product_store_stock.create({
    product: store2Product.id,
    store: store2.id,
    stock: store2Product.stock
  })

  store2ProductUnpaid = await db.product.create({
    nameProduct: 'SEC_PRODUCT_S2_UNPAID',
    category: category.id,
    price: 31000,
    stock: 5,
    isAvailable: true
  })
  await db.product_store.create({ product: store2ProductUnpaid.id, store: store2.id })
  await db.product_store_stock.create({
    product: store2ProductUnpaid.id,
    store: store2.id,
    stock: store2ProductUnpaid.stock
  })

  store2BundleProduct = await db.product.create({
    nameProduct: 'SEC_PRODUCT_S2_BUNDLE',
    category: category.id,
    price: 22000,
    stock: 8,
    isAvailable: true
  })
  await db.product_store.create({ product: store2BundleProduct.id, store: store2.id })
  await db.product_store_stock.create({
    product: store2BundleProduct.id,
    store: store2.id,
    stock: store2BundleProduct.stock
  })

  // Store-2-owned bundle: must be rejected when claimed by store1.
  store2Bundle = await db.product_bundle.create({
    name: 'SEC_BUNDLE_S2',
    store: store2.id,
    bundlePrice: 45000,
    status: 'active',
    isAvailable: true
  })
  await db.product_bundle_item.create({
    bundleId: store2Bundle.id,
    product: store2BundleProduct.id,
    quantity: 1
  })

  // Same-store bundle (store1) whose component is a store-2-owned product:
  // the bundle row is fine, but the component must still be rejected — the
  // mutation boundary has to defend the whole bundle composition.
  store1BundleWithForeignComponent = await db.product_bundle.create({
    name: 'SEC_BUNDLE_S1_FOREIGN_COMP',
    store: store1.id,
    bundlePrice: 25000,
    status: 'active',
    isAvailable: true
  })
  await db.product_bundle_item.create({
    bundleId: store1BundleWithForeignComponent.id,
    product: store2BundleProduct.id,
    quantity: 1
  })

  memberStore1 = await db.member.create({
    name: 'SEC_MEMBER_S1',
    phoneNumber: '081111111111',
    store: store1.id,
    status: 'active'
  })
  memberStore2 = await db.member.create({
    name: 'SEC_MEMBER_S2',
    phoneNumber: '082222222222',
    store: store2.id,
    status: 'active'
  })
})

// Phase 39 — a successful QR order now occupies its table. table1/table2 are
// reused across many independent tests in this file as plain "any valid
// table" placeholders (none of them assert on table occupancy itself), and
// several tests intentionally leave their order unpaid/pending. Resetting
// before each test keeps every test's original, independent intent (each
// starts from an available table) without touching production behavior.
beforeEach(async () => {
  await db.table.update(
    { status: 'available' },
    { where: { id: [table1?.id, table2?.id, table2Store2?.id, tableQty?.id].filter(Boolean) } }
  )
})

afterAll(async () => {
  await db.taxConfig.destroy({
    where: { store: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
  // Sweep every order belonging to the two test stores — including any
  // orders tests intentionally failed before creating (RED-phase
  // artifacts) — so cleanup never trips over FK leftovers.
  const stores = [store1?.id, store2?.id].filter(Boolean)
  const storeOrders = stores.length
    ? await db.order.findAll({
        where: { store: stores },
        attributes: ['id'],
        paranoid: false
      })
    : []
  const allOrderIds = [
    ...new Set([...createdOrderIds, ...directOrderIds, ...storeOrders.map((o) => o.id)])
  ]
  if (allOrderIds.length) {
    await db.order_item.destroy({ where: { order: allOrderIds }, force: true })
    await db.transaction.destroy({ where: { order: allOrderIds }, force: true })
    await db.order_status.destroy({ where: { order: allOrderIds }, force: true })
    await db.order.destroy({ where: { id: allOrderIds }, force: true })
  }
  await db.cashRegister.destroy({ where: { store: [store1?.id, store2?.id].filter(Boolean) }, force: true })
  // Users last: open-register rows reference the opener (FK).
  await db.user.destroy({ where: { id: [9402] }, force: true })
  await db.best_selling.destroy({ where: { productId: product?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  const store2Products = [store2Product, store2ProductUnpaid, store2BundleProduct].filter(Boolean)
  for (const p of store2Products) {
    await db.best_selling.destroy({ where: { productId: p.id }, force: true })
    await db.stock_history.destroy({ where: { product: p.id }, force: true })
    await db.product_store_stock.destroy({ where: { product: p.id }, force: true })
    await db.product_store.destroy({ where: { product: p.id }, force: true })
  }
  if (memberStore1 || memberStore2) {
    await db.member.destroy(
      { where: { id: [memberStore1?.id, memberStore2?.id].filter(Boolean) }, force: true }
    )
  }
  if (store2Bundle) {
    await db.product_bundle_item.destroy({ where: { bundleId: store2Bundle.id }, force: true })
    await db.product_bundle.destroy({ where: { id: store2Bundle.id }, force: true })
  }
  if (store1BundleWithForeignComponent) {
    await db.product_bundle_item.destroy(
      { where: { bundleId: store1BundleWithForeignComponent.id }, force: true }
    )
    await db.product_bundle.destroy({ where: { id: store1BundleWithForeignComponent.id }, force: true })
  }
  if (product) {
    await product.update({ stock: initialProductStock })
    await db.product.destroy({ where: { id: product.id }, force: true })
  }
  if (store2Products.length) {
    await db.product.destroy({ where: { id: store2Products.map((p) => p.id) }, force: true })
  }
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.table.destroy(
    { where: { id: [table1?.id, table2?.id, table2Store2?.id, tableQty?.id].filter(Boolean) }, force: true }
  )
  await db.location.destroy(
    { where: { id: [store1?.id, store2?.id].filter(Boolean) }, force: true }
  )
})

describe('SEC-001/SEC-006 — quantity trust boundary on customer-create', () => {
  const post = (quantity, extra = {}) =>
    request(app).post('/order/customer-create').send({
      store: store1.id,
      tableId: tableQty.id,
      paymentMethod: 'cash',
      customerName: 'SEC Qty',
      items: [{ productId: product.id, productName: product.nameProduct, quantity }],
      ...extra
    })

  test.each([
    ['-1 (negative)', -1],
    ['-10 (negative)', -10],
    ['0 (zero)', 0],
    ['1.5 (decimal)', 1.5],
    ['-1.5 (negative decimal)', -1.5],
    ['"2" (numeric string)', '2'],
    ['null (NaN/Infinity serializes to null)', null],
    ['999999 (beyond stock)', 999999]
  ])('rejects quantity %s with HTTP 400 and no side effects', async (_label, quantity) => {
    const before = await db.product.findByPk(product.id)
    const orderCountBefore = await db.order.count({ where: { store: store1.id } })

    const res = await post(quantity)

    expect(res.status).toBe(400)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(Number(before.stock))
    const orderCountAfter = await db.order.count({ where: { store: store1.id } })
    expect(orderCountAfter).toBe(orderCountBefore)
  })

  test('accepts a positive integer quantity, then deducts stock exactly once on the trusted paid transition', async () => {
    const before = await db.product.findByPk(product.id)

    // 1) Public QR create: order is recorded UNPAID — no stock or ledger
    //    mutation may happen here (AUD-1 trust boundary).
    const res = await post(1)

    expect(res.status).toBe(201)
    expect(Number(res.body.data.totalQuantity)).toBe(1)
    expect(Number(res.body.data.totalPrice)).toBeGreaterThan(0)
    expect(res.body.data.paymentStatus).toBe('unpaid')
    expect(res.body.data.status).toBe('pending')
    createdOrderIds.push(res.body.data.id)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(Number(before.stock))
    expect(await db.transaction.findAll({ where: { order: res.body.data.id } })).toHaveLength(0)

    // 2) Cashier marks it paid through the authorized order-status
    //    transition: that single event is where the stock deduction and the
    //    payment-ledger row belong, exactly once.
    const paid = await markOrderPaid(adminTokenStore1, {
      id: res.body.data.id,
      status: 'paid'
    })

    expect(paid.status).toBe(200)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(before.stock - 1)
    const ledgerRows = await db.transaction.findAll({
      where: { order: res.body.data.id }
    })
    expect(ledgerRows.length).toBe(1)
  })

  test('rejects an invalid quantity even when no paymentMethod is supplied', async () => {
    const before = await db.product.findByPk(product.id)
    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store1.id,
        tableId: tableQty.id,
        customerName: 'SEC Qty Unpaid',
        items: [{ productId: product.id, productName: product.nameProduct, quantity: 0 }]
      })
    expect(res.status).toBe(400)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(Number(before.stock))
  })
})

describe('SEC-002 — customer-orders scoped to an authorized table', () => {
  beforeAll(async () => {
    await makeDirectOrder(store1.id, table1.id, { session: null })
    await makeDirectOrder(store1.id, table1.id, { session: null })
    await makeDirectOrder(store1.id, table2.id)
    await makeDirectOrder(store1.id, table2.id)
    await makeDirectOrder(store1.id, table2.id)
    await makeDirectOrder(store2.id, table2Store2.id)
    await makeDirectOrder(store2.id, table2Store2.id)
  })

  test('bare store query (no tableId) is rejected — no store-wide disclosure', async () => {
    const res = await request(app).get('/order/customer-orders').query({ store: store1.id })
    expect(res.status).toBe(400)
    expect(res.body.data).toBeUndefined()
  })

  test('non-numeric or unknown tableId is rejected', async () => {
    const bad = await request(app)
      .get('/order/customer-orders')
      .query({ store: store1.id, tableId: 'abc' })
    expect(bad.status).toBe(400)

    const wrong = await request(app)
      .get('/order/customer-orders')
      .query({ store: store1.id, tableId: 99999999 })
    expect(wrong.status).toBe(400)
  })

  test('table 1 returns ONLY table 1 orders, scoped count included', async () => {
    const res = await request(app)
      .get('/order/customer-orders')
      .query({ store: store1.id, tableId: table1.id })

    expect(res.status).toBe(200)
    expect(res.body.pagination.total).toBe(2)
    expect(res.body.data.length).toBe(2)
    for (const order of res.body.data) {
      expect(order.tableId).toBe(table1.id)
    }
  })

  test('table 2 does not disclose table 1 orders', async () => {
    const res = await request(app)
      .get('/order/customer-orders')
      .query({ store: store1.id, tableId: table2.id })

    expect(res.status).toBe(200)
    expect(res.body.pagination.total).toBe(3)
    expect(res.body.data.every((o) => o.tableId === table2.id)).toBe(true)
  })

  test('pagination total stays scoped to the authorized table', async () => {
    const page1 = await request(app)
      .get('/order/customer-orders')
      .query({ store: store1.id, tableId: table1.id, page: 1, limit: 1 })
    expect(page1.status).toBe(200)
    expect(page1.body.data.length).toBe(1)
    expect(page1.body.pagination.total).toBe(2)

    const page2 = await request(app)
      .get('/order/customer-orders')
      .query({ store: store1.id, tableId: table1.id, page: 2, limit: 1 })
    expect(page2.status).toBe(200)
    expect(page2.body.data.length).toBe(1)
    expect(page2.body.pagination.total).toBe(2)
  })

  test('optional session narrows the authorized table further', async () => {
    await makeDirectOrder(store2.id, table2Store2.id, { session: 'sec-session-a' })

    const res = await request(app)
      .get('/order/customer-orders')
      .query({ store: store2.id, tableId: table2Store2.id, session: 'sec-session-a' })

    expect(res.status).toBe(200)
    expect(res.body.pagination.total).toBe(1)
    expect(res.body.data.every((o) => o.session === 'sec-session-a')).toBe(true)
  })

  test('store 1 cannot read another store table 2 orders (wrong store/table pair)', async () => {
    const res = await request(app)
      .get('/order/customer-orders')
      .query({ store: store2.id, tableId: table2.id })

    expect(res.status).toBe(400)
    expect(res.body.data).toBeUndefined()
  })
})

describe('SEC-003 — customer-menu response carries only customer-safe fields', () => {
  const FORBIDDEN_KEYS = [
    'costPrice',
    'hppPerPorsi',
    'foodCostPersen',
    'marginPersen',
    'minStock',
    'createdBy',
    'modifiedBy',
    'createdByUser',
    'modifiedByUser'
  ]

  test('internal financial/staff fields are absent from the whole response', async () => {
    const res = await request(app).get('/order/customer-menu').query({ store: store1.id })

    expect(res.status).toBe(200)
    const keys = deepKeys(res.body)
    for (const key of FORBIDDEN_KEYS) {
      expect(keys).not.toContain(key)
    }
  })

  test('customer-facing product fields survive', async () => {
    const res = await request(app).get('/order/customer-menu').query({ store: store1.id })

    expect(res.status).toBe(200)
    const found = res.body.data.products.find((p) => String(p.id) === String(product.id))
    expect(found).toBeDefined()
    expect(found.nameProduct).toBe('SEC_PRODUCT')
    expect(Number(found.price)).toBe(12000)
    expect(found.isAvailable).toBe(true)
    expect(Number(found.stock)).toBe(Number((await db.product.findByPk(product.id)).stock))
    expect(Array.isArray(found.options)).toBe(true)
    expect(Array.isArray(found.composition)).toBe(true)
  })
})

describe('SEC-004 — customer-create rejects cross-store product/bundle/customerId (SEC-CROSS-PRODUCT / SEC-CROSS-BUNDLE / SEC-CROSS-MEMBER)', () => {
  test('SEC-CROSS-PRODUCT — store 1 paid order referencing a store 2 product: 400, no order, no stock mutation', async () => {
    const beforeStock = Number((await db.product.findByPk(store2Product.id)).stock)
    const ordersBefore = await db.order.count({ where: { store: store1.id } })

    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store1.id,
        tableId: table1.id,
        paymentMethod: 'cash',
        customerName: 'SEC Cross Product',
        items: [
          { productId: store2Product.id, productName: store2Product.nameProduct, quantity: 1 }
        ]
      })

    expect(res.status).toBe(400)
    expect(Number((await db.product.findByPk(store2Product.id)).stock)).toBe(beforeStock)
    expect(await db.order.count({ where: { store: store1.id } })).toBe(ordersBefore)
  })

  test('SEC-CROSS-PRODUCT — store 1 unpaid order referencing a store 2 product is rejected too', async () => {
    const beforeStock = Number((await db.product.findByPk(store2ProductUnpaid.id)).stock)
    const ordersBefore = await db.order.count({ where: { store: store1.id } })

    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store1.id,
        tableId: table1.id,
        customerName: 'SEC Cross Product Unpaid',
        items: [
          {
            productId: store2ProductUnpaid.id,
            productName: store2ProductUnpaid.nameProduct,
            quantity: 1
          }
        ]
      })

    expect(res.status).toBe(400)
    expect(Number((await db.product.findByPk(store2ProductUnpaid.id)).stock)).toBe(beforeStock)
    expect(await db.order.count({ where: { store: store1.id } })).toBe(ordersBefore)
  })

  test('SEC-CROSS-BUNDLE — store 1 order referencing a store 2 bundle: 400, no order, no stock mutation', async () => {
    const beforeStock = Number((await db.product.findByPk(store2BundleProduct.id)).stock)
    const ordersBefore = await db.order.count({ where: { store: store1.id } })

    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store1.id,
        tableId: table1.id,
        customerName: 'SEC Cross Bundle',
        items: [
          { bundleId: store2Bundle.id, bundleName: store2Bundle.name, quantity: 1 }
        ]
      })

    expect(res.status).toBe(400)
    expect(Number((await db.product.findByPk(store2BundleProduct.id)).stock)).toBe(beforeStock)
    expect(await db.order.count({ where: { store: store1.id } })).toBe(ordersBefore)
  })

  test('SEC-CROSS-BUNDLE — store 1 bundle whose component is a store 2 product: 400 — components cannot bypass', async () => {
    const beforeStock = Number((await db.product.findByPk(store2BundleProduct.id)).stock)
    const ordersBefore = await db.order.count({ where: { store: store1.id } })

    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store1.id,
        tableId: table1.id,
        customerName: 'SEC Cross Bundle Component',
        items: [
          {
            bundleId: store1BundleWithForeignComponent.id,
            bundleName: store1BundleWithForeignComponent.name,
            quantity: 1
          }
        ]
      })

    expect(res.status).toBe(400)
    expect(Number((await db.product.findByPk(store2BundleProduct.id)).stock)).toBe(beforeStock)
    expect(await db.order.count({ where: { store: store1.id } })).toBe(ordersBefore)
  })

  test('SEC-CROSS-MEMBER — store 1 order with a store 2 customerId: 400, no order', async () => {
    const ordersBefore = await db.order.count({ where: { store: store1.id } })

    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store1.id,
        tableId: table1.id,
        paymentMethod: 'cash',
        customerId: memberStore2.id,
        customerName: 'SEC Cross Member',
        items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
      })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('MEMBER_ATTACH_REQUIRES_STAFF')
    expect(await db.order.count({ where: { store: store1.id } })).toBe(ordersBefore)
  })

  // G-01 (DR-16 / DR-23 §H): a same-store customerId is guessable too, so the
  // public route refuses it; staff attach a verified member at settlement.
  test('SEC-CROSS-MEMBER — store 1 order with a store 1 customerId is refused: 400, no order', async () => {
    const ordersBefore = await db.order.count({ where: { store: store1.id } })

    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store1.id,
        tableId: table1.id,
        paymentMethod: 'cash',
        customerId: memberStore1.id,
        customerName: 'SEC Same Store Member',
        items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
      })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('MEMBER_ATTACH_REQUIRES_STAFF')
    expect(await db.order.count({ where: { store: store1.id } })).toBe(ordersBefore)
  })
})

describe('SEC-PAYMENT-SPOOF — public customer-create cannot self-authorize a paid state (AUD-1)', () => {
  test('an unauthenticated QR request cannot produce a paid order, a ledger, or a stock deduction', async () => {
    const beforeStock = Number((await db.product.findByPk(product.id)).stock)

    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store1.id,
        tableId: table1.id,
        paymentMethod: 'cash',
        customerName: 'SEC Spoof',
        items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
      })

    expect(res.status).toBe(201)
    expect(res.body.data.paymentStatus).toBe('unpaid')
    expect(res.body.data.status).toBe('pending')
    createdOrderIds.push(res.body.data.id)

    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(beforeStock)
    const ledgerRows = await db.transaction.findAll({
      where: { order: res.body.data.id }
    })
    expect(ledgerRows.length).toBe(0)
  })

  test.each([
    ['paymentStatus spoof', { paymentMethod: 'cash', paymentStatus: 'paid' }],
    ['status spoof', { paymentMethod: 'cash', status: 'paid' }],
    ['isPaid spoof', { paymentMethod: 'cash', isPaid: true, paid: true }],
    ['typePayment spoof', { paymentMethod: 'cash', typePayment: 'card' }],
    ['bare paymentStatus paid', { paymentStatus: 'paid' }],
    ['bare status paid', { status: 'paid', isPaid: true }]
  ])('%s can never flip the order to paid', async (_label, extra) => {
    const beforeStock = Number((await db.product.findByPk(product.id)).stock)

    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store1.id,
        tableId: table1.id,
        customerName: 'SEC Spoof Matrix',
        items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
        ...extra
      })

    expect(res.status).toBe(201)
    expect(res.body.data.paymentStatus).toBe('unpaid')
    expect(res.body.data.status).toBe('pending')
    createdOrderIds.push(res.body.data.id)

    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(beforeStock)
    const ledgerRows = await db.transaction.findAll({
      where: { order: res.body.data.id }
    })
    expect(ledgerRows.length).toBe(0)
  })
})