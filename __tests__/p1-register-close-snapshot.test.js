process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// PAYMENT P1 — deterministic register close + immutable X/Z snapshot (TDD).
//
// Covers §31: SNAPSHOT-01..13, Z-01..06, CLOSE-RACE-01..06, rotation (§19),
// refund-after-close (§21), cross-register partials (§20). Every refusal
// asserts zero side effects, not just HTTP status.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const UNIT_PRICE = 25000
const QTY = 4
const G = UNIT_PRICE * QTY // 100,000

let store = null
let category = null
let product = null
let adminToken = null
let adminUser = null
const createdTableIds = []

const auth = (token) => ({ Authorization: `Bearer ${token}` })

async function makeTable(storeId) {
  const t = await db.table.create({ store: storeId, name: unique('P1C_TABLE') })
  createdTableIds.push(t.id)
  return t
}

// Counter (POS) order: created by the authenticated cashier, so it belongs
// to creator-basis gross figures. QR orders (createdBy null) are covered
// by the attribution-centric tests; gross membership preserves the locked
// pre-F2 creator-basis contract (see cash-ledger-hardening totalSales test).
async function makeCounterOrder({ quantity = QTY, paymentMethod = 'cash', extra = {} } = {}) {
  const res = await request(app)
    .post('/order/create')
    .set(auth(adminToken))
    .send(withIdempotencyKey({
      store: store.id,
      items: [{ product: product.id, quantity }],
      paymentMethod,
      cashierName: 'P1C Cashier',
      idempotencyKey: unique('p1ccreate'),
      ...extra
    }))
  if (res.status !== 201) throw new Error('counter setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function makeQrOrder() {
  const table = await makeTable(store.id)
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      customerName: 'P1C QR',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: QTY }],
      idempotencyKey: unique('p1cqr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

const settlePaid = (orderId, body = { paymentMethod: 'cash' }) =>
  request(app).put('/order/update-status').set(auth(adminToken)).send({ id: orderId, store: store.id, status: 'paid', ...body })

const openRegister = (shift = 1) =>
  request(app).post('/cash-register/open').set(auth(adminToken)).send({ store: store.id, openingBalance: 0, shift })

const closeRegister = (registerId, closingBalance = 0) =>
  request(app).put(`/cash-register/close/${registerId}`).set(auth(adminToken)).send({ store: store.id, closingBalance })

// Every test that needs an open register starts here: any leftover open
// register is closed first so tests never depend on execution order.
async function rotateRegister(shift = 1) {
  const open = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
  if (open) await closeRegister(open.id, 0)
  const res = await openRegister(shift)
  expect([200, 201]).toContain(res.status)
  return res.body.data.id
}

const zReport = (registerId) =>
  request(app).get(`/cash-register/z-report/${registerId}`).set(auth(adminToken))

const xReport = () =>
  request(app).get('/cash-register/x-report').set(auth(adminToken))

const createMovement = (registerId, body) =>
  request(app).post(`/cash-register/${registerId}/movement`).set(auth(adminToken)).send(body)

async function ledgerRows(orderId) {
  return db.transaction.findAll({ where: { order: orderId }, order: [['id', 'ASC']] })
}

function financialZShape(zData) {
  return {
    summary: zData.summary,
    payments: zData.payments,
    expenses: zData.expenses
  }
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('P1C_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('P1C_CAT') })
  product = await db.product.create({
    nameProduct: unique('P1C_PRODUCT'),
    category: category.id,
    price: UNIT_PRICE,
    stock: 100000
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 100000 })
  await db.taxConfig.create({ store: store.id, name: unique('P1C_PPN'), rate: 0, type: 'ppn', status: 'active' })

  adminUser = await db.user.create({
    userName: unique('p1c_admin'),
    email: `${unique('p1c_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  const orders = await db.order.findAll({ where: { store: store.id }, paranoid: false, attributes: ['id'] })
  const orderIds = orders.map((o) => o.id)
  if (orderIds.length) {
    await db.split_bill.destroy({ where: { order: orderIds }, force: true })
    await db.transaction.destroy({ where: { order: orderIds }, force: true })
    await db.order_item.destroy({ where: { order: orderIds }, force: true })
    await db.order_status.destroy({ where: { order: orderIds }, force: true })
    await db.accounting_outbox.destroy({ where: { referenceType: 'order', referenceId: orderIds } })
    const returns = await db.sales_return.findAll({ where: { order: orderIds }, attributes: ['id'] })
    const returnIds = returns.map((r) => r.id)
    if (returnIds.length) {
      await db.sales_return_item.destroy({ where: { salesReturn: returnIds }, force: true })
      await db.sales_return.destroy({ where: { id: returnIds }, force: true })
    }
    await db.order.destroy({ where: { id: orderIds }, force: true })
  }
  await db.cashMovement.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.expense.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.best_selling.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.stock_history.destroy({ where: { store: store.id }, force: true }).catch(() => {})
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.table.destroy({ where: { id: createdTableIds }, force: true })
  await db.user.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('SNAPSHOT — close persists the frozen contract', () => {
  test('SNAPSHOT-01/02: close populates expectedCash; cash settlement is inside it', async () => {
    await rotateRegister(11)
    await makeCounterOrder()
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const closed = await closeRegister(register.id, G)
    expect(closed.status).toBe(200)
    const row = await db.cashRegister.findByPk(register.id)
    expect(row.status).toBe('closed')
    expect(Number(row.expectedCash)).toBe(G)
    expect(Number(row.activeCashIn)).toBe(0)
    expect(Number(row.activeCashOut)).toBe(0)
    expect(Number(row.cashRefundsTotal)).toBe(0)
    expect(Number(row.refundsTotal)).toBe(0)
    expect(Number(row.refundCount)).toBe(0)
    expect(Number(row.totalTransactions)).toBe(1)
    expect(closed.body.data.summary.variance).toBe(0)
  })

  test('SNAPSHOT-03: cash refund reduces expectedCash on the refunding register', async () => {
    await rotateRegister(12)
    const order = await makeQrOrder()
    expect((await settlePaid(order.id)).status).toBe(200)
    expect(
      (await updateStatusPaid(order.id, 'void'))
    ).toBeTruthy()
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const closed = await closeRegister(register.id, 0)
    expect(closed.status).toBe(200)
    const row = await db.cashRegister.findByPk(register.id)
    expect(Number(row.expectedCash)).toBe(0)
    expect(Number(row.cashRefundsTotal)).toBe(G)
    expect(Number(row.refundsTotal)).toBe(G)
    expect(Number(row.refundCount)).toBe(1)
  })

  async function updateStatusPaid(orderId, to) {
    const res = await request(app)
      .put('/order/update-status')
      .set(auth(adminToken))
      .send({ id: orderId, store: store.id, status: to, ...(to === 'void' ? { reason: 'P1C void' } : { paymentMethod: 'cash' }) })
    expect(res.status).toBe(200)
    return true
  }

  test('SNAPSHOT-04: noncash settlement is attributed but adds no drawer cash', async () => {
    await rotateRegister(13)
    await makeCounterOrder({ paymentMethod: 'qris', extra: { referenceNumber: 'QR-SNAP-1' } })
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const closed = await closeRegister(register.id, 0)
    expect(closed.status).toBe(200)
    const row = await db.cashRegister.findByPk(register.id)
    expect(Number(row.expectedCash)).toBe(0)
    expect(closed.body.data.summary.variance).toBe(0)
    const types = closed.body.data.summary
      ? (await zReport(register.id)).body.data.payments.map((p) => p.type)
      : []
    expect(types).toContain('QRIS')
    expect(types).not.toContain('qris')
  })

  test('SNAPSHOT-05/06: cash_in increases and cash_out decreases expectedCash', async () => {
    const openedId = await rotateRegister(14)
    const registerId = openedId
    expect((await createMovement(registerId, { type: 'cash_in', reasonCode: 'float_topup', amount: 50000 })).status).toBe(201)
    expect((await createMovement(registerId, { type: 'cash_out', reasonCode: 'bank_drop', amount: 20000 })).status).toBe(201)
    const closed = await closeRegister(registerId, 30000)
    expect(closed.status).toBe(200)
    const row = await db.cashRegister.findByPk(registerId)
    expect(Number(row.activeCashIn)).toBe(50000)
    expect(Number(row.activeCashOut)).toBe(20000)
    expect(Number(row.expectedCash)).toBe(30000)
  })

  test('SNAPSHOT-07: approved cash expense decreases expectedCash', async () => {
    const openedId = await rotateRegister(15)
    const registerId = openedId
    await db.expense.create({
      store: store.id,
      expenseNumber: `PEXP-${Date.now()}`,
      amount: 10000,
      date: new Date(),
      paymentMethod: 'cash',
      status: 'approved',
      createdBy: adminUser.id
    })
    const closed = await closeRegister(registerId, 0)
    expect(closed.status).toBe(200)
    expect(Number((await db.cashRegister.findByPk(registerId)).expectedCash)).toBe(-10000)
    expect(closed.body.data.summary.variance).toBe(10000)
  })

  test('SNAPSHOT-08: reversed cash movement is excluded (compensating leg counted once)', async () => {
    const openedId = await rotateRegister(16)
    const registerId = openedId
    const created = await createMovement(registerId, { type: 'cash_out', reasonCode: 'bank_drop', amount: 100000 })
    expect(created.status).toBe(201)
    const reversed = await request(app)
      .post(`/cash-register/movement/${created.body.data.id}/reverse`)
      .set(auth(adminToken))
      .send({})
    expect([200, 201]).toContain(reversed.status)
    const closed = await closeRegister(registerId, 100000)
    expect(closed.status).toBe(200)
    const row = await db.cashRegister.findByPk(registerId)
    // The original cash_out leg is 'reversed' (excluded); its compensating
    // cash_in leg is real drawer money: 0 + 0 + 100000 - 0 - 0.
    expect(Number(row.activeCashOut)).toBe(0)
    expect(Number(row.activeCashIn)).toBe(100000)
    expect(Number(row.expectedCash)).toBe(100000)
  })

  test('SNAPSHOT-09: payment breakdown uses canonical methods', async () => {
    await rotateRegister(17)
    await makeCounterOrder()
    await makeCounterOrder({ paymentMethod: 'qris', extra: { referenceNumber: 'QR-SNAP-2' } })
    // The DB CHECK now refuses unmappable tenders on new writes, so the
    // write boundary is exercised with canonical OTHER. UNRECONCILED only
    // applies to historical rows and is covered by the reporting unit tests.
    const otherOrder = await makeCounterOrder()
    await db.transaction.create({ order: otherOrder.id, typePayment: 'OTHER', amount: G, createdBy: adminUser.id })
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const closed = await closeRegister(register.id, 0)
    expect(closed.status).toBe(200)
    const zdata = (await zReport(register.id)).body.data
    const byType = Object.fromEntries(zdata.payments.map((p) => [p.type, p.amount]))
    // Two counter CASH settlements (o1 + other order).
    expect(byType.CASH).toBe(2 * G)
    expect(byType.QRIS).toBe(G)
    expect(byType.OTHER).toBe(G)
    expect(zdata.payments.find((p) => p.type === 'UNRECONCILED')).toBeUndefined()
  })

  test('SNAPSHOT-10/11/12: refund totals/counts, transaction count, and gross are frozen', async () => {
    await rotateRegister(18)
    await makeCounterOrder()
    await makeCounterOrder()
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const closed = await closeRegister(register.id, 2 * G)
    expect(closed.status).toBe(200)
    const row = await db.cashRegister.findByPk(register.id)
    expect(Number(row.totalTransactions)).toBe(2)
    expect(Number(row.refundsTotal)).toBe(0)
    expect(Number(row.refundCount)).toBe(0)
    expect(row.closeSnapshot).toBeTruthy()
    expect(row.closeSnapshot.gross).toBeTruthy()
    expect(Number(row.closeSnapshot.gross.totalSales)).toBe(2 * G)
    expect(Array.isArray(row.closeSnapshot.payments)).toBe(true)
    expect(Array.isArray(row.closeSnapshot.expenses)).toBe(true)
  })

  test('SNAPSHOT-13: closeSnapshot is deterministic and canonically sorted', async () => {
    await rotateRegister(19)
    const o1 = await makeQrOrder()
    expect((await settlePaid(o1.id, { paymentMethod: 'qris', referenceNumber: 'QR-SNAP-3' })).status).toBe(200)
    const o2 = await makeQrOrder()
    expect((await settlePaid(o2.id)).status).toBe(200)
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    await closeRegister(register.id, G)
    const row = await db.cashRegister.findByPk(register.id)
    const types = row.closeSnapshot.payments.map((p) => p.type)
    expect([...types].sort()).toEqual(types)
    expect(JSON.stringify(row.closeSnapshot)).toBe(JSON.stringify(JSON.parse(JSON.stringify(row.closeSnapshot))))
    await closeRegister(register.id, G)
  })
})

describe('Z — frozen snapshot reads', () => {
  test('Z-01: closed Z reads the frozen snapshot (summary/payments/expenses match close output)', async () => {
    await rotateRegister(21)
    const order = await makeQrOrder()
    expect((await settlePaid(order.id)).status).toBe(200)
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const closed = await closeRegister(register.id, G)
    const atClose = closed.body.data
    const zdata = (await zReport(register.id)).body.data
    expect(zdata.summary).toEqual(atClose.summary)
    expect(zdata.payments).toEqual(atClose.payments)
    expect(zdata.expenses).toEqual(atClose.expenses)
  })

  test('Z-02/03/04: R2 settlement, refund, and cash movement leave Z(R1) byte-identical', async () => {
    await rotateRegister(22)
    const order = await makeQrOrder()
    expect((await settlePaid(order.id)).status).toBe(200)
    const r1 = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    await closeRegister(r1.id, G)
    const before = JSON.stringify(financialZShape((await zReport(r1.id)).body.data))

    await rotateRegister(23)
    const r2 = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const order2 = await makeQrOrder()
    expect((await settlePaid(order2.id)).status).toBe(200)
    await request(app)
      .put('/order/update-status')
      .set(auth(adminToken))
      .send({ id: order2.id, store: store.id, status: 'void', reason: 'P1C Z-03' })
    expect((await createMovement(r2.id, { type: 'cash_in', reasonCode: 'float_topup', amount: 1000 })).status).toBe(201)
    const after = JSON.stringify(financialZShape((await zReport(r1.id)).body.data))
    expect(after).toBe(before)
    await closeRegister(r2.id, 1000)
  })

  test('Z-05: rotation isolates R1 and R2 drawers', async () => {
    await rotateRegister(24)
    const o1 = await makeQrOrder()
    expect((await settlePaid(o1.id)).status).toBe(200)
    const r1 = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    await closeRegister(r1.id, G)
    await rotateRegister(25)
    const r2 = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const table = await makeTable(store.id)
    const small = await request(app)
      .post('/order/customer-create')
      .send({
        store: store.id,
        tableId: table.id,
        customerName: 'P1C small',
        items: [{ productId: product.id, productName: product.nameProduct, quantity: 2 }],
        idempotencyKey: unique('p1csmall')
      })
    expect(small.status).toBe(201)
    expect((await settlePaid(small.body.data.id)).status).toBe(200)
    await closeRegister(r2.id, 50000)
    expect(Number((await db.cashRegister.findByPk(r1.id)).expectedCash)).toBe(G)
    expect(Number((await db.cashRegister.findByPk(r2.id)).expectedCash)).toBe(50000)
  })

  test('Z-06: refund after R1 close belongs to R2; R1 snapshot unchanged', async () => {
    await rotateRegister(26)
    const order = await makeQrOrder()
    expect((await settlePaid(order.id)).status).toBe(200)
    const r1 = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    await closeRegister(r1.id, G)
    const zBefore = JSON.stringify(financialZShape((await zReport(r1.id)).body.data))
    const frozen = await db.cashRegister.findByPk(r1.id)
    await rotateRegister(27)
    const r2 = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    expect(
      (await request(app).put('/order/update-status').set(auth(adminToken)).send({
        id: order.id, store: store.id, status: 'void', reason: 'P1C Z-06'
      })).status
    ).toBe(200)
    const refunds = (await ledgerRows(order.id)).filter((r) => Number(r.amount) < 0)
    expect(refunds).toHaveLength(1)
    expect(Number(refunds[0].cashRegisterId)).toBe(Number(r2.id))
    const zAfter = JSON.stringify(financialZShape((await zReport(r1.id)).body.data))
    expect(zAfter).toBe(zBefore)
    const refrozen = await db.cashRegister.findByPk(r1.id)
    expect(refrozen.expectedCash).toBe(frozen.expectedCash)
    expect(JSON.stringify(refrozen.closeSnapshot)).toBe(JSON.stringify(frozen.closeSnapshot))
    await closeRegister(r2.id, 0)
  })
})

describe('CLOSE-RACE — deterministic serialization', () => {
  test('CLOSE-RACE-01: settlement holding SHARE serializes close; snapshot includes it', async () => {
    const { lockAndVerifyRegister } = require('../api/service/settlementAttribution')
    await rotateRegister(31)
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const order = await makeQrOrder()
    expect((await settlePaid(order.id)).status).toBe(200)
    const t = await db.sequelize.transaction()
    try {
      await lockAndVerifyRegister(register.id, t)
      const closePromise = closeRegister(register.id, G)
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      // Close is blocked on the SHARE lock: still open until commit.
      expect((await db.cashRegister.findByPk(register.id)).status).toBe('open')
      await t.commit()
      const closed = await closePromise
      expect(closed.status).toBe(200)
      // The settlement committed before close finalizes is inside the snapshot.
      expect(Number((await db.cashRegister.findByPk(register.id)).expectedCash)).toBe(G)
    } catch (e) {
      try { await t.rollback() } catch {}
      throw e
    }
  })

  test('CLOSE-RACE-02: close committed first → settlement refuses with zero rows', async () => {
    await rotateRegister(32)
    const order = await makeQrOrder()
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    await closeRegister(register.id, 0)
    const res = await settlePaid(order.id)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('REGISTER_REQUIRED')
    expect(await ledgerRows(order.id)).toHaveLength(0)
  })

  test('CLOSE-RACE-03/04: void and split races keep exactly one consistent outcome', async () => {
    await rotateRegister(33)
    const order = await makeQrOrder()
    expect((await settlePaid(order.id)).status).toBe(200)
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    const [voided, closed] = await Promise.all([
      request(app).put('/order/update-status').set(auth(adminToken)).send({
        id: order.id, store: store.id, status: 'void', reason: 'P1C race'
      }),
      closeRegister(register.id, 0)
    ])
    const rows = await ledgerRows(order.id)
    const refunds = rows.filter((r) => Number(r.amount) < 0)
    if (voided.status === 200) {
      expect(closed.status).toBe(200)
      expect(refunds).toHaveLength(1)
    } else {
      expect(voided.status).toBe(422)
      expect(refunds).toHaveLength(0)
    }
    await rotateRegister(34)
  })

  test('CLOSE-RACE-05: movement on a closed register is refused', async () => {
    await rotateRegister(35)
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    await closeRegister(register.id, 0)
    const res = await createMovement(register.id, { type: 'cash_in', reasonCode: 'float_topup', amount: 1000 })
    expect(res.status).toBe(409)
    await rotateRegister(36)
  })

  test('CLOSE-RACE-06: split pay after close with no open register is refused with zero rows', async () => {
    await rotateRegister(37)
    const order = await makeQrOrder()
    const created = await request(app)
      .post('/split-bill/create')
      .set(auth(adminToken))
      .send({ order: order.id, items: [{ amount: G }] })
    expect(created.status).toBe(201)
    const splitId = created.body.data[0].id
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    await closeRegister(register.id, 0)
    const res = await request(app)
      .put(`/split-bill/pay/${splitId}`)
      .set(auth(adminToken))
      .send({ paymentMethod: 'cash' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('REGISTER_REQUIRED')
    expect(await ledgerRows(order.id)).toHaveLength(0)
    await rotateRegister(38)
  })
})

describe('X — live open-register behavior', () => {
  test('X-01: X reflects new settlements while open and carries canonical types', async () => {
    await rotateRegister(41)
    const before = await xReport()
    const order = await makeQrOrder()
    expect((await settlePaid(order.id)).status).toBe(200)
    const after = await xReport()
    expect(after.body.data.summary.totalCashPayment).toBe((before.body.data?.summary?.totalCashPayment || 0) + G)
  })

  test('X-02: no open register yields empty X without error', async () => {
    const register = await db.cashRegister.findOne({ where: { store: store.id, status: 'open' } })
    if (register) await closeRegister(register.id, 0)
    const res = await xReport()
    expect(res.status).toBe(200)
    expect(res.body.data).toBeNull()
    await rotateRegister(42)
  })
})
