process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { normalizePaymentMethod } = require('../api/service/canonicalPayment')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Batch B RED: /cash-register/history/detail shows a frozen close snapshot
// (paid-only, opener-attributed) next to a live store+date order list of ALL
// statuses with NOTHING explaining which transactions count toward the
// summary. The Z-report (the canonical breakdown endpoint) exposes no
// inclusion rules and no per-order eligibility, so the page cannot
// reconcile. This suite pins the reconciliation contract:
//
//   GET /cash-register/z-report/:id → data.reconciliation = {
//     window, sales: { eligible, excluded[] }, expenses, movements }
//
// Every test below FAILS against the current implementation
// (data.reconciliation is undefined) for the actual root cause.

const SUFFIX = Date.now()

let store = null
let storeOther = null
let opener = null
let otherCashier = null
let adminToken = null
let register = null
let emptyRegister = null

// Fixed register window: 10:00:00Z .. 10:05:00Z on 2026-09-12.
const OPENED_AT = new Date('2026-09-12T10:00:00.000Z')
const CLOSED_AT = new Date('2026-09-12T10:05:00.000Z')
const at = (ms) => new Date(OPENED_AT.getTime() + ms)

const AMT_CASH = 27750
const AMT_QRIS = 27750
const AMT_EWALLET = 55500
const AMT_BIG = 99999999999999 // 15 digits: exact under Number.MAX_SAFE_INTEGER
const ELIGIBLE_TOTAL = AMT_CASH + AMT_QRIS + AMT_EWALLET + AMT_BIG

const orderIds = {}
constTxIds = []
const expenseIds = {}

async function mkOrder(name, overrides) {
  const row = await db.order.create({
    orderNumber: `ZREC-${name}-${SUFFIX}`,
    store: store.id,
    status: 'served',
    paymentStatus: 'unpaid',
    source: 'pos',
    totalPrice: 0,
    ...overrides
  })
  orderIds[name] = row.id
  return row
}

async function mkTx(orderId, typePayment, amount) {
  const row = await db.transaction.create({
    order: orderId,
    typePayment: normalizePaymentMethod(typePayment),
    amount
  })
  constTxIds.push(row.id)
  return row
}

async function mkExpense(name, overrides) {
  const row = await db.expense.create({
    expenseNumber: `ZREC-EXP-${name}-${SUFFIX}`,
    store: store.id,
    amount: 0,
    date: at(120000),
    paymentMethod: 'cash',
    status: 'approved',
    ...overrides
  })
  expenseIds[name] = row.id
  return row
}

beforeAll(async () => {
  store = await db.location.create({ name: `ZREC_STORE_${SUFFIX}` })
  storeOther = await db.location.create({ name: `ZREC_STORE_OTHER_${SUFFIX}` })

  opener = await db.user.create({
    userName: `zrec_opener_${SUFFIX}`,
    roleType: 'admin',
    store: store.id,
    password: 'x'
  })
  otherCashier = await db.user.create({
    userName: `zrec_cashier_${SUFFIX}`,
    roleType: 'kasir',
    store: store.id,
    password: 'x'
  })
  adminToken = await signSessionToken(
    { id: opener.id, userName: opener.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )

  register = await db.cashRegister.create({
    store: store.id,
    user: opener.id,
    shift: 1,
    openingBalance: 200000,
    closingBalance: 200000,
    status: 'closed',
    openedAt: OPENED_AT,
    closedAt: CLOSED_AT
  })
  emptyRegister = await db.cashRegister.create({
    store: store.id,
    user: opener.id,
    shift: 2,
    openingBalance: 50000,
    closingBalance: 50000,
    status: 'closed',
    openedAt: at(3600000),
    closedAt: at(3660000)
  })

  // ---- eligible sales (paid, opener, in-window) ----
  const o1 = await mkOrder('CASH', {
    createdBy: opener.id,
    createdAt: at(60000),
    paymentStatus: 'paid',
    paymentMethod: 'cash',
    totalPrice: AMT_CASH
  })
  await mkTx(o1.id, 'cash', AMT_CASH)

  const o2 = await mkOrder('QRIS', {
    createdBy: opener.id,
    createdAt: at(120000),
    paymentStatus: 'paid',
    paymentMethod: 'qris',
    totalPrice: AMT_QRIS
  })
  await mkTx(o2.id, 'qris', AMT_QRIS)

  const o3 = await mkOrder('EWALLET', {
    createdBy: opener.id,
    createdAt: at(180000),
    paymentStatus: 'paid',
    paymentMethod: 'e-wallet',
    totalPrice: AMT_EWALLET
  })
  await mkTx(o3.id, 'e-wallet', AMT_EWALLET)

  const o11 = await mkOrder('BIG', {
    createdBy: opener.id,
    createdAt: at(240000),
    paymentStatus: 'paid',
    paymentMethod: 'cash',
    totalPrice: AMT_BIG
  })
  await mkTx(o11.id, 'cash', AMT_BIG)

  // createdAt exactly at openedAt boundary → inside window (>=).
  const o12 = await mkOrder('EDGE_OPEN', {
    createdBy: opener.id,
    createdAt: new Date(OPENED_AT.getTime()),
    paymentStatus: 'paid',
    paymentMethod: 'cash',
    totalPrice: 1000
  })
  await mkTx(o12.id, 'cash', 1000)

  // ---- excluded sales ----
  await mkOrder('UNPAID', {
    createdBy: opener.id,
    createdAt: at(60000),
    paymentStatus: 'unpaid',
    status: 'preparing',
    paymentMethod: 'qris',
    totalPrice: 27750
  })
  await mkOrder('CANCELLED', {
    createdBy: opener.id,
    createdAt: at(60000),
    paymentStatus: 'unpaid',
    status: 'cancelled',
    paymentMethod: 'cash',
    totalPrice: 27750
  })
  await mkOrder('OTHER_CREATOR', {
    createdBy: otherCashier.id,
    createdAt: at(60000),
    paymentStatus: 'paid',
    status: 'served',
    paymentMethod: 'cash',
    totalPrice: 27750
  })
  await mkOrder('AFTER_CLOSE', {
    createdBy: opener.id,
    createdAt: new Date(CLOSED_AT.getTime() + 60000),
    paymentStatus: 'paid',
    status: 'served',
    paymentMethod: 'cash',
    totalPrice: 27750
  })
  await mkOrder('BEFORE_OPEN', {
    createdBy: opener.id,
    createdAt: new Date(OPENED_AT.getTime() - 1000),
    paymentStatus: 'paid',
    status: 'served',
    paymentMethod: 'cash',
    totalPrice: 27750
  })
  await mkOrder('REFUNDED', {
    createdBy: opener.id,
    createdAt: at(60000),
    paymentStatus: 'refunded',
    status: 'served',
    paymentMethod: 'cash',
    totalPrice: 27750
  })
  // other store: must appear nowhere.
  await db.order.create({
    orderNumber: `ZREC-OTHERSTORE-${SUFFIX}`,
    store: storeOther.id,
    createdBy: opener.id,
    createdAt: at(60000),
    paymentStatus: 'paid',
    status: 'served',
    source: 'pos',
    paymentMethod: 'cash',
    totalPrice: 99999
  })

  // ---- expenses ----
  // approved cash in-window, recorded by ANOTHER cashier → still included
  // (existing contract has no createdBy filter on cash expenses).
  await mkExpense('CASH_OK', {
    createdBy: otherCashier.id,
    createdAt: at(120000),
    amount: 15000
  })
  await mkExpense('NON_CASH', {
    createdBy: opener.id,
    createdAt: at(120000),
    paymentMethod: 'e-wallet',
    amount: 20000
  })
  await mkExpense('PENDING', {
    createdBy: opener.id,
    createdAt: at(120000),
    status: 'pending',
    amount: 30000
  })
  await mkExpense('OUT_WINDOW', {
    createdBy: opener.id,
    createdAt: new Date(CLOSED_AT.getTime() + 60000),
    amount: 40000
  })
  await db.expense.create({
    expenseNumber: `ZREC-EXP-OTHERSTORE-${SUFFIX}`,
    store: storeOther.id,
    amount: 77777,
    date: at(120000),
    createdAt: at(120000),
    paymentMethod: 'cash',
    status: 'approved'
  })

  // ---- cash movements ----
  await db.cashMovement.create({
    store: store.id,
    cashRegisterId: register.id,
    type: 'cash_in',
    reasonCode: 'correction',
    amount: 5000,
    status: 'active',
    createdBy: opener.id
  })
  await db.cashMovement.create({
    store: store.id,
    cashRegisterId: register.id,
    type: 'cash_out',
    reasonCode: 'petty_cash',
    amount: 2000,
    status: 'active',
    createdBy: opener.id
  })
})

afterAll(async () => {
  await db.transaction.destroy({ where: { id: constTxIds }, force: true }).catch(() => {})
  await db.order.destroy({ where: { store: [store?.id, storeOther?.id].filter(Boolean) }, force: true }).catch(() => {})
  await db.expense.destroy({ where: { store: [store?.id, storeOther?.id].filter(Boolean) }, force: true }).catch(() => {})
  await db.cashMovement.destroy({ where: { cashRegisterId: [register?.id, emptyRegister?.id].filter(Boolean) }, force: true }).catch(() => {})
  await db.cashRegister.destroy({ where: { id: [register?.id, emptyRegister?.id].filter(Boolean) }, force: true }).catch(() => {})
  await db.user.destroy({ where: { id: [opener?.id, otherCashier?.id].filter(Boolean) }, force: true }).catch(() => {})
  await db.location.destroy({ where: { id: [store?.id, storeOther?.id].filter(Boolean) }, force: true }).catch(() => {})
})

async function zReport(id, token = adminToken) {
  return request(app)
    .get(`/cash-register/z-report/${id}`)
    .set('Authorization', `Bearer ${token}`)
}

describe('Batch B RED — register reconciliation contract', () => {
  test('R1 — z-report exposes a reconciliation block', async () => {
    const res = await zReport(register.id)
    expect(res.status).toBe(200)
    expect(res.body.data.reconciliation).toBeDefined()
  })

  test('R2 — eligible sales are exactly the paid opener in-window orders', async () => {
    const res = await zReport(register.id)
    const eligible = res.body.data.reconciliation.sales.eligible
    expect(eligible.count).toBe(5)
    expect(eligible.total).toBe(ELIGIBLE_TOTAL + 1000)
    expect(new Set(eligible.orderIds).size).toBe(5)
    for (const name of ['CASH', 'QRIS', 'EWALLET', 'BIG', 'EDGE_OPEN']) {
      expect(eligible.orderIds).toContain(orderIds[name])
    }
  })

  test('R3 — eligible sales split by payment method', async () => {
    const res = await zReport(register.id)
    const byMethod = res.body.data.reconciliation.sales.eligible.byPaymentMethod
    const byType = Object.fromEntries(byMethod.map((r) => [r.type, r]))
    expect(byType.CASH.amount).toBe(AMT_CASH + AMT_BIG + 1000)
    expect(byType.QRIS.amount).toBe(AMT_QRIS)
    expect(byType.E_WALLET.amount).toBe(AMT_EWALLET)
  })

  test('R4 — excluded sales carry explicit reason codes', async () => {
    const res = await zReport(register.id)
    const excluded = res.body.data.reconciliation.sales.excluded
    const byCode = Object.fromEntries(excluded.map((r) => [r.code, r]))
    expect(byCode.UNPAID.orderIds).toContain(orderIds.UNPAID)
    expect(byCode.CANCELLED_VOID.orderIds).toContain(orderIds.CANCELLED)
    expect(byCode.OTHER_CREATOR.orderIds).toContain(orderIds.OTHER_CREATOR)
    expect(byCode.OUTSIDE_WINDOW.orderIds).toEqual(
      expect.arrayContaining([orderIds.AFTER_CLOSE, orderIds.BEFORE_OPEN])
    )
    expect(byCode.REFUNDED.orderIds).toContain(orderIds.REFUNDED)
    // eligible and excluded populations are disjoint.
    const eligibleIds = new Set(res.body.data.reconciliation.sales.eligible.orderIds)
    for (const bucket of excluded) {
      for (const id of bucket.orderIds) {
        expect(eligibleIds.has(id)).toBe(false)
      }
    }
  })

  test('R5 — cash expenses reconcile with the displayed total and exclusions are explicit', async () => {
    const res = await zReport(register.id)
    const rec = res.body.data.reconciliation.expenses
    expect(rec.includedCash.total).toBe(15000)
    expect(rec.includedCash.total).toBe(res.body.data.summary.totalExpenses)
    const byCode = Object.fromEntries(rec.excluded.map((r) => [r.code, r]))
    expect(byCode.NON_CASH_METHOD.total).toBe(20000)
    expect(byCode.NOT_APPROVED.total).toBe(30000)
    expect(byCode.OUTSIDE_WINDOW.total).toBe(40000)
  })

  test('R6 — cash movements are broken down', async () => {
    const res = await zReport(register.id)
    const movements = res.body.data.reconciliation.movements
    expect(movements.cashIn).toMatchObject({ count: 1, total: 5000 })
    expect(movements.cashOut).toMatchObject({ count: 1, total: 2000 })
  })

  test('R7 — other-store records never leak into any population', async () => {
    const res = await zReport(register.id)
    const rec = res.body.data.reconciliation
    expect(rec.sales.eligible.total).toBe(ELIGIBLE_TOTAL + 1000)
    expect(rec.expenses.includedCash.total).toBe(15000)
    const allSalesIds = [
      ...rec.sales.eligible.orderIds,
      ...rec.sales.excluded.flatMap((b) => b.orderIds)
    ]
    const otherStoreOrder = await db.order.findOne({
      where: { orderNumber: `ZREC-OTHERSTORE-${SUFFIX}` }
    })
    expect(allSalesIds).not.toContain(otherStoreOrder.id)
  })

  test('R8 — empty register reconciles to zero without errors', async () => {
    const res = await zReport(emptyRegister.id)
    expect(res.status).toBe(200)
    const rec = res.body.data.reconciliation
    expect(rec.sales.eligible).toMatchObject({ count: 0, total: 0 })
    expect(rec.expenses.includedCash).toMatchObject({ count: 0, total: 0 })
  })

  test('R9 — BIGINT amounts survive aggregation exactly', async () => {
    const res = await zReport(register.id)
    expect(res.body.data.reconciliation.sales.eligible.total).toBe(ELIGIBLE_TOTAL + 1000)
  })

  test('R10 — cross-store access stays forbidden', async () => {
    const otherAdmin = await db.user.create({
      userName: `zrec_other_admin_${SUFFIX}`,
      roleType: 'admin',
      store: storeOther.id,
      password: 'x'
    })
    const otherToken = await signSessionToken(
      { id: otherAdmin.id, userName: otherAdmin.userName, roleType: 'admin', store: storeOther.id },
      JWT_SECRET
    )
    const res = await zReport(register.id, otherToken)
    expect(res.status).toBe(403)
    await db.user.destroy({ where: { id: otherAdmin.id }, force: true })
  })
})
