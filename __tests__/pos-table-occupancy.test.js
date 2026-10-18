process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 39 — POS table occupancy (locked spec).
//  - A POS dine-in order claims its table (available -> occupied) inside the
//    order's own transaction, under a row lock; takeaway never touches tables.
//  - An occupied/reserved/maintenance/missing/other-store table is rejected,
//    and POS and QR share table.status (each rejects the other's claim).
//  - A POS visit is released ONLY by Table Management "Set Available" — never
//    by its order's payment, kitchen statuses, cancel or void. Since DR-24
//    C-16/D-03 that release is an elevated action: admin-only with a
//    mandatory reason (fixtures therefore release with the admin token).
//  - Same-key retries replay the winner; a different key is a new request.

const SUFFIX = Date.now()
let store = null
let otherStore = null
let category = null
let product = null
let lowStockProduct = null
let cashierToken = null
let adminToken = null
const tableIds = []

const token = () => cashierToken

const mkTable = async (status = 'available', storeId = store.id) => {
  const table = await db.table.create({
    store: storeId,
    name: `POS_OCC_${tableIds.length}_${SUFFIX}`,
    status
  })
  tableIds.push(table.id)
  return table
}

const posOrder = (tableId, { key, quantity = 1, productId } = {}) => {
  const body = {
    store: store.id,
    items: [{ product: productId || product.id, quantity }],
    paymentMethod: 'cash',
    cashierName: 'POS Occupancy Cashier'
  }
  if (tableId !== undefined) body.tableId = tableId
  if (key) body.idempotencyKey = key
  return request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${token()}`)
    .send(withIdempotencyKey(body))
}

const qrOrder = (tableId, key) =>
  request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId,
      customerName: 'QR Diner',
      idempotencyKey: key,
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
    })

const updateStatus = (body, asToken = token()) =>
  request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${asToken}`)
    .send({ store: store.id, ...body })

const setAvailable = (tableId) =>
  request(app)
    .put(`/table/update-status/${tableId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ status: 'available', reason: 'POS occupancy test release' })

const tableStatus = async (id) => (await db.table.findByPk(id)).status
const ordersOnTable = (tableId) => db.order.count({ where: { tableId } })
const key = (label) => `pos-occ-${label}-${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`
const errorText = (res) => res.body.message || res.body.error

const countRows = async (sqlTable) => {
  const [rows] = await db.sequelize.query(`SELECT COUNT(*)::int AS n FROM "${sqlTable}"`)
  return rows[0].n
}

beforeAll(async () => {
  store = await db.location.create({ name: `POS_OCC_STORE_${SUFFIX}`, status: 'active' })
  otherStore = await db.location.create({ name: `POS_OCC_OTHER_${SUFFIX}`, status: 'active' })
  category = await db.category.create({ name: `POS_OCC_CAT_${SUFFIX}` })
  product = await db.product.create({
    nameProduct: `POS_OCC_PRODUCT_${SUFFIX}`,
    category: category.id,
    price: 10000,
    stock: 1000,
    isAvailable: true
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  // Per-store stock passes the pre-transaction check; the test below makes
  // the locked in-transaction read of the outlet row see 1 (as if another
  // sale took the stock in between) — so the failure happens AFTER the
  // table claim, proving the claim rolls back.
  lowStockProduct = await db.product.create({
    nameProduct: `POS_OCC_LOW_${SUFFIX}`,
    category: category.id,
    price: 10000,
    stock: 1,
    isAvailable: true
  })
  await db.product_store_stock.create({ product: lowStockProduct.id, store: store.id, stock: 100 })

  // P1-4: central gate denies unknown caller identities; this row gives the
  // caller id a real identity. Assertions below are unchanged.
  await db.user.create({
    id: 9711,
    userName: 'pos_occ_cashier',
    email: 'p14-9711-pos-occ@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store.id,
    status: 'active',
    fullName: 'pos_occ_cashier'
  })
  await db.user.create({
    id: 9712,
    userName: 'pos_occ_admin',
    email: 'p14-9712-pos-occ@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'pos_occ_admin'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  cashierToken = await signSessionToken(
    { id: 9711, userName: 'pos_occ_cashier', roleType: 'kasir', store: store.id },
    JWT_SECRET
  )
  adminToken = await signSessionToken(
    { id: 9712, userName: 'pos_occ_admin', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  // DR-23: a void's cash refund is attributed to the open register; POS
  // sales made while it is open belong to it.
  await db.cashRegister.create({
    store: store.id,
    user: 9712,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these occupancy assertions exercise configured tax.
  for (const s of [store, otherStore]) {
    await db.taxConfig.create({
      name: `POS_OCC_PPN_${s.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: s.id
    })
  }
})

afterAll(async () => {
  jest.restoreAllMocks()
  await db.cashRegister.destroy({ where: { store: [store?.id, otherStore?.id].filter(Boolean) }, force: true })
  await db.user.destroy({ where: { id: [9711, 9712] }, force: true })
  await db.taxConfig.destroy({
    where: { store: [store?.id, otherStore?.id].filter(Boolean) },
    force: true
  })
  const orders = await db.order.findAll({
    where: { store: [store?.id, otherStore?.id].filter(Boolean) },
    attributes: ['id']
  })
  const orderIds = orders.map((o) => o.id)
  if (orderIds.length) {
    await db.order_item.destroy({ where: { order: orderIds }, force: true })
    await db.order_status.destroy({ where: { order: orderIds }, force: true })
    await db.transaction.destroy({ where: { order: orderIds }, force: true })
    await db.order.destroy({ where: { id: orderIds }, force: true })
  }
  const productIds = [product?.id, lowStockProduct?.id].filter(Boolean)
  await db.stock_history.destroy({ where: { product: productIds }, force: true })
  await db.best_selling.destroy({ where: { productId: productIds }, force: true })
  await db.product_store_stock.destroy({ where: { product: productIds }, force: true })
  await db.product.destroy({ where: { id: productIds }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.table.destroy({ where: { id: tableIds }, force: true })
  await db.location.destroy({ where: { id: [store?.id, otherStore?.id].filter(Boolean) }, force: true })
})

describe('POS occupancy — claim', () => {
  test('a dine-in POS order claims its table: available -> occupied', async () => {
    const table = await mkTable()
    const res = await posOrder(table.id)
    expect(res.status).toBe(201)
    expect(res.body.data.tableId).toBe(table.id)
    expect(await tableStatus(table.id)).toBe('occupied')
  })

  test('a takeaway POS order does not mutate any table', async () => {
    const table = await mkTable()
    const before = await db.table.findByPk(table.id)
    const res = await posOrder(undefined)
    expect(res.status).toBe(201)
    expect(res.body.data.tableId).toBeNull()
    const after = await db.table.findByPk(table.id)
    expect(after.status).toBe('available')
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
  })

  test('a missing table is rejected (400) with no order and no stock change', async () => {
    const stockBefore = Number((await db.product.findByPk(product.id)).stock)
    const res = await posOrder(987654321)
    expect(res.status).toBe(400)
    expect(errorText(res)).toBe('Table not found')
    expect(await ordersOnTable(987654321)).toBe(0)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(stockBefore)
  })

  test("another store's table is rejected (400) and left untouched", async () => {
    const foreign = await mkTable('available', otherStore.id)
    const res = await posOrder(foreign.id)
    expect(res.status).toBe(400)
    expect(errorText(res)).toBe('Table not found')
    expect(await tableStatus(foreign.id)).toBe('available')
    expect(await ordersOnTable(foreign.id)).toBe(0)
  })

  test.each(['reserved', 'maintenance'])('a %s table is rejected (400) and keeps its status', async (status) => {
    const table = await mkTable(status)
    const res = await posOrder(table.id)
    expect(res.status).toBe(400)
    expect(errorText(res)).toBe('Table is not available')
    expect(await tableStatus(table.id)).toBe(status)
    expect(await ordersOnTable(table.id)).toBe(0)
  })

  test('a failure after the claim (stock, inside the transaction) rolls the table back to available', async () => {
    const table = await mkTable()
    // DR-14: the in-transaction re-check reads the locked outlet row. Make
    // that locked read observe 1 unit left, as a concurrent sale would.
    const realFindOne = db.product_store_stock.findOne.bind(db.product_store_stock)
    const spy = jest
      .spyOn(db.product_store_stock, 'findOne')
      .mockImplementation(async (opts) => {
        const row = await realFindOne(opts)
        if (opts?.lock && row && Number(row.product) === lowStockProduct.id) row.stock = 1
        return row
      })
    let res
    try {
      res = await posOrder(table.id, { productId: lowStockProduct.id, quantity: 5 })
    } finally {
      spy.mockRestore()
    }
    expect(res.status).toBe(400)
    // "Tersedia: 1" is the locked in-transaction stock read, not the
    // per-store pre-check (100) — i.e. the claim had already happened.
    expect(errorText(res)).toMatch(/Tersedia: 1\b/)
    expect(await tableStatus(table.id)).toBe('available')
    expect(await ordersOnTable(table.id)).toBe(0)
  })
})

describe('POS occupancy — double order and cross-channel', () => {
  test('POS -> POS: a second POS order on a POS-occupied table is rejected', async () => {
    const table = await mkTable()
    expect((await posOrder(table.id)).status).toBe(201)
    const second = await posOrder(table.id)
    expect(second.status).toBe(400)
    expect(errorText(second)).toBe('Table is already occupied')
    expect(await ordersOnTable(table.id)).toBe(1)
  })

  test('POS -> QR: a QR order on a POS-occupied table is rejected', async () => {
    const table = await mkTable()
    expect((await posOrder(table.id)).status).toBe(201)
    const qr = await qrOrder(table.id, key('pos-then-qr'))
    expect(qr.status).toBe(400)
    expect(await ordersOnTable(table.id)).toBe(1)
    expect(await tableStatus(table.id)).toBe('occupied')
  })

  test('QR -> POS: a POS order on a QR-occupied table is rejected', async () => {
    const table = await mkTable()
    expect((await qrOrder(table.id, key('qr-then-pos'))).status).toBe(201)
    const pos = await posOrder(table.id)
    expect(pos.status).toBe(400)
    expect(errorText(pos)).toBe('Table is already occupied')
    expect(await ordersOnTable(table.id)).toBe(1)
  })
})

describe('POS occupancy — concurrency', () => {
  test('two concurrent POS orders (different keys) on one table: exactly one succeeds', async () => {
    const table = await mkTable()
    const [a, b] = await Promise.all([
      posOrder(table.id, { key: key('race-a') }),
      posOrder(table.id, { key: key('race-b') })
    ])
    expect([a.status, b.status].sort()).toEqual([201, 400])
    expect(await ordersOnTable(table.id)).toBe(1)
    expect(await tableStatus(table.id)).toBe('occupied')
  })

  test('concurrent POS and QR claims on one table: exactly one succeeds', async () => {
    const table = await mkTable()
    const [pos, qr] = await Promise.all([
      posOrder(table.id, { key: key('mixed-pos') }),
      qrOrder(table.id, key('mixed-qr'))
    ])
    expect([pos.status, qr.status].filter((s) => s === 201)).toHaveLength(1)
    expect(await ordersOnTable(table.id)).toBe(1)
    expect(await tableStatus(table.id)).toBe('occupied')
  })

  // Accepted limitation R5: queue seating writes `occupied` blindly (no row
  // lock, no status check), so it is NOT serialized against a POS claim and
  // both parties can end up believing they hold the table. This test pins
  // only what IS guaranteed — the status is never corrupted and at most one
  // POS order is created — and deliberately does not claim the race is solved.
  test('concurrent POS claim and queue seating: table ends occupied, at most one POS order (R5 not solved)', async () => {
    const table = await mkTable()
    const entry = await db.queue.create({
      store: [store.id],
      queueNumber: `Q${String(SUFFIX).slice(-6)}`,
      customerName: 'Queue Party',
      partySize: 2
    })
    try {
      const [pos, seat] = await Promise.all([
        posOrder(table.id, { key: key('queue-race') }),
        request(app)
          .put(`/queue/${entry.id}/status`)
          .set('Authorization', `Bearer ${token()}`)
          .send({ status: 'seated', tableId: table.id })
      ])
      expect(seat.status).toBe(200)
      expect([201, 400]).toContain(pos.status)
      expect(await ordersOnTable(table.id)).toBeLessThanOrEqual(1)
      expect(await tableStatus(table.id)).toBe('occupied')
    } finally {
      await db.queue.destroy({ where: { id: entry.id }, force: true })
    }
  })
})

describe('POS occupancy — idempotency', () => {
  test('sequential same-key retry replays the winner (200, same order)', async () => {
    const table = await mkTable()
    const k = key('seq')
    const first = await posOrder(table.id, { key: k })
    expect(first.status).toBe(201)
    const retry = await posOrder(table.id, { key: k })
    expect(retry.status).toBe(200)
    expect(retry.body.data.id).toBe(first.body.data.id)
    expect(await ordersOnTable(table.id)).toBe(1)
  })

  test('same-key retry in the pre-check window replays the winner instead of 400', async () => {
    const table = await mkTable()
    const k = key('precheck')
    const first = await posOrder(table.id, { key: k })
    expect(first.status).toBe(201)
    // Simulate the winner committing just after the retry's fast-path
    // lookup: the fast path misses, so the retry reaches the table
    // pre-check, which now sees the table occupied by that winner.
    const spy = jest.spyOn(db.order, 'findOne').mockResolvedValueOnce(null)
    const retry = await posOrder(table.id, { key: k })
    spy.mockRestore()
    expect(retry.status).toBe(200)
    expect(retry.body.data.id).toBe(first.body.data.id)
    expect(await ordersOnTable(table.id)).toBe(1)
  })

  test('concurrent same-key requests: one 201 + one 200 replay with the same order id', async () => {
    const table = await mkTable()
    const k = key('concurrent')
    const [a, b] = await Promise.all([posOrder(table.id, { key: k }), posOrder(table.id, { key: k })])
    expect([a.status, b.status].sort()).toEqual([200, 201])
    expect(a.body.data.id).toBe(b.body.data.id)
    expect(await ordersOnTable(table.id)).toBe(1)
    expect(await tableStatus(table.id)).toBe('occupied')
  })

  test('a different key on the occupied table is a new request and is rejected (400)', async () => {
    const table = await mkTable()
    expect((await posOrder(table.id, { key: key('owner') })).status).toBe(201)
    const other = await posOrder(table.id, { key: key('stranger') })
    expect(other.status).toBe(400)
    expect(errorText(other)).toBe('Table is already occupied')
    expect(await ordersOnTable(table.id)).toBe(1)
  })

  test('the same key with different items keeps the existing 409 mismatch', async () => {
    const table = await mkTable()
    const k = key('mismatch')
    expect((await posOrder(table.id, { key: k, quantity: 1 })).status).toBe(201)
    const mismatch = await posOrder(table.id, { key: k, quantity: 2 })
    expect(mismatch.status).toBe(409)
    expect(await ordersOnTable(table.id)).toBe(1)
  })
})

describe('POS occupancy — release', () => {
  test('Set Available releases the table and the next POS order can claim it', async () => {
    const table = await mkTable()
    expect((await posOrder(table.id)).status).toBe(201)
    const release = await setAvailable(table.id)
    expect(release.status).toBe(200)
    expect(await tableStatus(table.id)).toBe('available')
    expect((await posOrder(table.id)).status).toBe(201)
    expect(await tableStatus(table.id)).toBe('occupied')
  })

  test('Set Available does not touch the order, payment, ledger, stock, register or accounting', async () => {
    const table = await mkTable()
    const created = await posOrder(table.id)
    expect(created.status).toBe(201)
    const orderId = created.body.data.id

    const snapshot = async () => {
      const order = await db.order.findByPk(orderId)
      return {
        status: order.status,
        paymentStatus: order.paymentStatus,
        ledgerRows: await db.transaction.count({ where: { order: orderId } }),
        stock: Number((await db.product.findByPk(product.id)).stock),
        storeStock: Number(
          (await db.product_store_stock.findOne({ where: { product: product.id, store: store.id } })).stock
        ),
        registers: await countRows('cash_register'),
        outbox: await countRows('accounting_outbox'),
        journals: await countRows('journal_entry')
      }
    }

    const before = await snapshot()
    expect((await setAvailable(table.id)).status).toBe(200)
    expect(await tableStatus(table.id)).toBe('available')
    expect(await snapshot()).toEqual(before)
  })
})

describe('POS occupancy — order lifecycle never releases a POS visit', () => {
  test('preparing, ready, served and paid (again) leave the table occupied', async () => {
    const table = await mkTable()
    const created = await posOrder(table.id)
    expect(created.status).toBe(201)
    for (const status of ['preparing', 'ready', 'served']) {
      const res = await updateStatus({ id: created.body.data.id, status })
      expect(res.status).toBe(200)
      expect(await tableStatus(table.id)).toBe('occupied')
    }
    // DR-23 (BA §35.10 K): a repeated settlement of a PAID order is refused
    // on the fresh state (outstanding 0) instead of a hidden 200 no-op.
    const repaid = await updateStatus({ id: created.body.data.id, status: 'paid' })
    expect(repaid.status).toBe(409)
    expect(repaid.body.code).toBe('OUTSTANDING_CHANGED')
    expect(await tableStatus(table.id)).toBe('occupied')
    // Existing payment behavior intact: still paid, still exactly one ledger row.
    expect((await db.order.findByPk(created.body.data.id)).paymentStatus).toBe('paid')
    expect(await db.transaction.count({ where: { order: created.body.data.id } })).toBe(1)
  })

  test('kitchen item progress up to served leaves the table occupied', async () => {
    const table = await mkTable()
    const created = await posOrder(table.id)
    expect(created.status).toBe(201)
    const itemId = created.body.data.items[0].id
    for (const itemStatus of ['preparing', 'ready', 'served']) {
      const res = await request(app)
        .put('/order/update-item-status')
        .set('Authorization', `Bearer ${token()}`)
        .send({ id: created.body.data.id, itemId, itemStatus })
      expect(res.status).toBe(200)
    }
    expect((await db.order.findByPk(created.body.data.id)).status).toBe('served')
    expect(await tableStatus(table.id)).toBe('occupied')
  })

  // DR-23 (BA §35.10 G): a PAID POS order cannot be cancelled (money is
  // collected → CANCEL_REQUIRES_VOID); it is reversed by an elevated void.
  test('cancelling a paid POS order is refused and leaves table, stock and ledger untouched', async () => {
    const table = await mkTable()
    const stockBefore = Number((await db.product.findByPk(product.id)).stock)
    const created = await posOrder(table.id, { quantity: 2 })
    expect(created.status).toBe(201)
    const orderId = created.body.data.id

    const res = await updateStatus({ id: orderId, status: 'cancelled', reason: 'POS occupancy test' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CANCEL_REQUIRES_VOID')

    const order = await db.order.findByPk(orderId)
    expect(order.status).toBe('paid')
    expect(order.paymentStatus).toBe('paid')
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(stockBefore - 2)
    expect(await db.transaction.count({ where: { order: orderId } })).toBe(1)
    expect(await tableStatus(table.id)).toBe('occupied')
  })

  test('void leaves the POS table occupied, with its refund/stock/ledger effects intact', async () => {
    const table = await mkTable()
    const stockBefore = Number((await db.product.findByPk(product.id)).stock)
    const created = await posOrder(table.id, { quantity: 2 })
    expect(created.status).toBe(201)
    const orderId = created.body.data.id
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(stockBefore - 2)

    const res = await updateStatus({ id: orderId, status: 'void', reason: 'POS occupancy test' }, adminToken)
    expect(res.status).toBe(200)

    const order = await db.order.findByPk(orderId)
    expect(order.status).toBe('void')
    expect(order.paymentStatus).toBe('refunded')
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(stockBefore)
    const ledger = await db.transaction.findAll({ where: { order: orderId } })
    expect(ledger).toHaveLength(2)
    expect(ledger.map((r) => Math.sign(Number(r.amount))).sort()).toEqual([-1, 1])

    expect(await tableStatus(table.id)).toBe('occupied')
  })

  test('QR release semantics are unchanged: a cancelled QR order still frees its table', async () => {
    const table = await mkTable()
    const qr = await qrOrder(table.id, key('qr-release'))
    expect(qr.status).toBe(201)
    expect(await tableStatus(table.id)).toBe('occupied')
    const res = await updateStatus({ id: qr.body.data.id, status: 'cancelled' })
    expect(res.status).toBe(200)
    expect(await tableStatus(table.id)).toBe('available')
  })
})
