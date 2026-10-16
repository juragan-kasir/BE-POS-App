process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let category = null
let productA = null
let cashierToken = null
let tableA = null

beforeAll(async () => {
  location = await db.location.create({ name: 'TAX_CT_STORE', status: 'active' })
  category = await db.category.create({ name: 'TAX_CT_CATEGORY' })
  productA = await db.product.create({
    nameProduct: 'TAX_CT_PRODUCT_A',
    category: category.id,
    price: 10000,
    stock: 100
  })
  // Match the store-scoped stock row a live store would have.
  await db.product_store_stock.create({ product: productA.id, store: location.id, stock: 100 })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7002,
    userName: 'cashier_tax_ct',
    email: 'p14-7002-order-tax-contract@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: location.id,
    status: 'active',
    fullName: 'cashier_tax_ct'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  cashierToken = await signSessionToken(
    { id: 7002, userName: 'cashier_tax_ct', roleType: 'kasir', store: location.id },
    JWT_SECRET
  )
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: location.id, user: 7002, status: 'open', openingBalance: 0, openedAt: new Date() })
  tableA = await db.table.create({ store: location.id, name: 'TAX_CT_TABLE', capacity: 4 })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.user.destroy({ where: { id: [7002] }, force: true })
  await db.taxConfig.destroy({ where: { store: null, name: 'TEST_GLOBAL_PPN' }, force: true })
  await db.taxConfig.destroy({ where: { store: location.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.table.destroy({ where: { id: tableA?.id }, force: true })
  await db.best_selling.destroy({ where: { productId: productA?.id }, force: true })
  await db.stock_history.destroy({ where: { product: productA?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: productA?.id }, force: true })
  await db.product.destroy({ where: { id: productA?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

const orderOne = (overrides = {}) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send(withIdempotencyKey({
      store: location.id,
      items: [{ product: productA.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'Tax Contract',
      ...overrides
    }))

describe('tax config resolution contract (F-SMOKE-01)', () => {
  test('a global (store: null) active PPN config prices the order — not the 11% fallback', async () => {
    await db.taxConfig.destroy({ where: { store: null, name: 'TEST_GLOBAL_PPN' }, force: true })
    await db.taxConfig.create({
      name: 'TEST_GLOBAL_PPN',
      rate: 7,
      type: 'ppn',
      status: 'active',
      store: null
    })

    const res = await orderOne()

    expect(res.status).toBe(201)
    // 10000 @ 7% — the global config must win over the undocumented 11% fallback.
    expect(Number(res.body.data.taxAmount)).toBe(700)
    expect(Number(res.body.data.totalPrice)).toBe(10700)
  })

  test('a per-store active PPN overrides the global default (D3: never stacked)', async () => {
    await db.taxConfig.destroy({ where: { store: null, name: 'TEST_GLOBAL_PPN' }, force: true })
    await db.taxConfig.destroy({ where: { store: location.id, name: 'TEST_STORE_PPN' }, force: true })
    await db.taxConfig.create({
      name: 'TEST_GLOBAL_PPN',
      rate: 7,
      type: 'ppn',
      status: 'active',
      store: null
    })
    await db.taxConfig.create({
      name: 'TEST_STORE_PPN',
      rate: 9,
      type: 'ppn',
      status: 'active',
      store: location.id
    })

    const res = await orderOne()

    expect(res.status).toBe(201)
    // D3 (decided 2026-10-16): the outlet's own 9% replaces the global 7%;
    // the UI shows the same applied rate (GET /order/customer-tax-rate).
    expect(Number(res.body.data.taxAmount)).toBe(900)
    expect(Number(res.body.data.totalPrice)).toBe(10900)
  })

  test('legacy percentage-typed rows are never treated as PPN — missing PPN setup fails explicitly instead of the removed 11% fallback', async () => {
    await db.taxConfig.destroy({ where: { store: null, name: 'TEST_GLOBAL_PPN' }, force: true })
    await db.taxConfig.destroy({ where: { store: location.id }, force: true })
    await db.taxConfig.create({
      name: 'LEGACY_PERCENTAGE_ROW',
      rate: 5,
      type: 'percentage',
      status: 'active',
      store: location.id
    })

    const before = await db.order.count({ where: { store: location.id } })
    const res = await orderOne()

    // W3-3 (DR-17): no ppn row means an explicit 400 setup error — never a
    // silent 11% fallback — and no order is persisted.
    expect(res.status).toBe(400)
    expect(String(res.body.error || '')).toMatch(/PPN tax configuration is missing/)
    expect(await db.order.count({ where: { store: location.id } })).toBe(before)
  })

  test('non-cash payment without PPN configuration fails explicitly instead of succeeding with fallback tax', async () => {
    await db.taxConfig.destroy({ where: { store: null, name: 'TEST_GLOBAL_PPN' }, force: true })
    await db.taxConfig.destroy({ where: { store: location.id }, force: true })

    const before = await db.order.count({ where: { store: location.id } })
    const res = await orderOne({ paymentMethod: 'e-wallet' })

    // W3-3 (DR-17): payment method is orthogonal to PPN setup — the missing
    // configuration still fails explicitly with nothing persisted.
    expect(res.status).toBe(400)
    expect(String(res.body.error || '')).toMatch(/PPN tax configuration is missing/)
    expect(await db.order.count({ where: { store: location.id } })).toBe(before)
  })

  test('a global (store: null) active service charge config is applied — the same store-or-global resolution as tax', async () => {
    await db.taxConfig.destroy({ where: { store: null, name: 'TEST_GLOBAL_PPN' }, force: true })
    await db.taxConfig.destroy({ where: { store: location.id }, force: true })
    await db.taxConfig.destroy({
      where: { store: null, name: 'TEST_GLOBAL_SERVICE_CHARGE' },
      force: true
    })
    await db.taxConfig.create({
      name: 'TEST_GLOBAL_PPN',
      rate: 7,
      type: 'ppn',
      status: 'active',
      store: null
    })
    await db.taxConfig.create({
      name: 'TEST_GLOBAL_SERVICE_CHARGE',
      rate: 5,
      type: 'service_charge',
      status: 'active',
      store: null
    })

    const res = await orderOne()

    expect(res.status).toBe(201)
    // 10000 @ 7% ppn = 700; service charge is on the post-discount subtotal,
    // 10000 @ 5% = 500 — a global service_charge row must not be ignored.
    expect(Number(res.body.data.taxAmount)).toBe(700)
    expect(Number(res.body.data.totalPrice)).toBe(11200)

    await db.taxConfig.destroy({
      where: { store: null, name: 'TEST_GLOBAL_SERVICE_CHARGE' },
      force: true
    })
  })
})

describe('W3-3 DR-17 hardened resolver contract', () => {
  const clearStoreConfigs = () =>
    db.taxConfig.destroy({ where: { store: location.id }, force: true })
  const clearGlobalConfigs = () =>
    db.taxConfig.destroy({ where: { store: null, name: ['TEST_GLOBAL_PPN', 'TEST_GLOBAL_SERVICE_CHARGE'] }, force: true })

  const orderQr = () =>
    db.table
      .update({ status: 'available' }, { where: { id: tableA.id } })
      .then(() =>
        request(app)
          .post('/order/customer-create')
          .send({
            store: location.id,
            tableId: tableA.id,
            customerName: 'Tax Contract QR',
            items: [{ productId: productA.id, productName: 'TAX_CT_PRODUCT_A', quantity: 1 }],
            session: `tax-ct-${Date.now()}-${Math.random()}`
          })
      )

  test('explicitly configured 0% PPN succeeds with zero tax (0 is valid config, not missing)', async () => {
    await clearGlobalConfigs()
    await clearStoreConfigs()
    await db.taxConfig.create({
      name: 'TEST_ZERO_PPN',
      rate: 0,
      type: 'ppn',
      status: 'active',
      store: location.id
    })

    const res = await orderOne()

    expect(res.status).toBe(201)
    expect(Number(res.body.data.taxRate)).toBe(0)
    expect(Number(res.body.data.taxAmount)).toBe(0)
  })

  test('non-cash payment with PPN configured is accepted (method orthogonal to setup)', async () => {
    await clearGlobalConfigs()
    await clearStoreConfigs()
    await db.taxConfig.create({
      name: 'TEST_STORE_PPN',
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: location.id
    })

    const res = await orderOne({ paymentMethod: 'e-wallet' })

    expect(res.status).toBe(201)
    expect(res.body.data.paymentMethod).toBe('E_WALLET')
  })

  test('counter with no service-charge rows charges 0 service charge (absence is valid)', async () => {
    await clearGlobalConfigs()
    await clearStoreConfigs()
    await db.taxConfig.create({
      name: 'TEST_STORE_PPN',
      rate: 10,
      type: 'ppn',
      status: 'active',
      store: location.id
    })

    const res = await orderOne()

    expect(res.status).toBe(201)
    expect(Number(res.body.data.serviceChargeAmount)).toBe(0)
    expect(Number(res.body.data.totalPrice)).toBe(11000)
  })

  test('PPN read failure does not become 11% — the order fails instead', async () => {
    await clearGlobalConfigs()
    await clearStoreConfigs()
    await db.taxConfig.create({
      name: 'TEST_STORE_PPN',
      rate: 10,
      type: 'ppn',
      status: 'active',
      store: location.id
    })
    const spy = jest.spyOn(db.taxConfig, 'findAll').mockRejectedValueOnce(new Error('db down'))
    try {
      const before = await db.order.count({ where: { store: location.id } })
      const res = await orderOne()

      expect(res.status).toBe(500)
      expect(await db.order.count({ where: { store: location.id } })).toBe(before)
    } finally {
      spy.mockRestore()
    }
  })

  test('service-charge read failure does not become 0 — the order fails instead', async () => {
    await clearGlobalConfigs()
    await clearStoreConfigs()
    await db.taxConfig.create({
      name: 'TEST_STORE_PPN',
      rate: 10,
      type: 'ppn',
      status: 'active',
      store: location.id
    })
    const orig = db.taxConfig.findAll.bind(db.taxConfig)
    const spy = jest
      .spyOn(db.taxConfig, 'findAll')
      .mockImplementation((opts) =>
        opts?.where?.type === 'service_charge'
          ? Promise.reject(new Error('db down'))
          : orig(opts)
      )
    try {
      const res = await orderOne()

      expect(res.status).toBe(500)
    } finally {
      spy.mockRestore()
    }
  })

  test('QR with missing PPN fails explicitly and persists nothing', async () => {
    await clearGlobalConfigs()
    await clearStoreConfigs()

    const before = await db.order.count({ where: { store: location.id } })
    const res = await orderQr()

    expect(res.status).toBe(400)
    expect(String(res.body.error || '')).toMatch(/PPN tax configuration is missing/)
    expect(await db.order.count({ where: { store: location.id } })).toBe(before)
  })

  test('QR never charges service charge even when service-charge config exists', async () => {
    await clearGlobalConfigs()
    await clearStoreConfigs()
    await db.taxConfig.create({
      name: 'TEST_STORE_PPN',
      rate: 10,
      type: 'ppn',
      status: 'active',
      store: location.id
    })
    await db.taxConfig.create({
      name: 'TEST_STORE_SC',
      rate: 5,
      type: 'service_charge',
      status: 'active',
      store: location.id
    })

    const res = await orderQr()

    expect(res.status).toBe(201)
    expect(Number(res.body.data.serviceChargeAmount)).toBe(0)
    expect(Number(res.body.data.totalPrice)).toBe(11000)
  })

  test('customer-tax-rate default channel preserves counter shape', async () => {
    await clearGlobalConfigs()
    await clearStoreConfigs()
    await db.taxConfig.create({
      name: 'TEST_STORE_PPN',
      rate: 10,
      type: 'ppn',
      status: 'active',
      store: location.id
    })

    const res = await request(app).get(`/order/customer-tax-rate?store=${location.id}`)

    expect(res.status).toBe(200)
    expect(Number(res.body.data.rate)).toBe(10)
    expect(Number(res.body.data.serviceChargeRate)).toBe(0)
  })

  test('customer-tax-rate qr channel resolves PPN but marks service charge not applicable', async () => {
    await clearGlobalConfigs()
    await clearStoreConfigs()
    await db.taxConfig.create({
      name: 'TEST_STORE_PPN',
      rate: 10,
      type: 'ppn',
      status: 'active',
      store: location.id
    })
    await db.taxConfig.create({
      name: 'TEST_STORE_SC',
      rate: 5,
      type: 'service_charge',
      status: 'active',
      store: location.id
    })

    const res = await request(app).get(
      `/order/customer-tax-rate?store=${location.id}&channel=qr`
    )

    expect(res.status).toBe(200)
    expect(Number(res.body.data.rate)).toBe(10)
    expect(res.body.data.serviceChargeRate).toBeNull()
  })

  test('customer-tax-rate rejects unknown channel instead of guessing', async () => {
    const res = await request(app).get(
      `/order/customer-tax-rate?store=${location.id}&channel=dinein`
    )

    expect(res.status).toBe(400)
  })

  test('customer-tax-rate with missing PPN fails explicitly', async () => {
    await clearGlobalConfigs()
    await clearStoreConfigs()

    const res = await request(app).get(`/order/customer-tax-rate?store=${location.id}`)

    expect(res.status).toBe(400)
    expect(String(res.body.message || '')).toMatch(/PPN tax configuration is missing/)
  })

  test('customer-tax-rate read failure is a 500, not a fallback rate', async () => {
    const spy = jest.spyOn(db.taxConfig, 'findAll').mockRejectedValueOnce(new Error('db down'))
    try {
      const res = await request(app).get(`/order/customer-tax-rate?store=${location.id}`)

      expect(res.status).toBe(500)
    } finally {
      spy.mockRestore()
    }
  })
})
