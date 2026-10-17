process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store = null
let storeOther = null
let category = null
let product = null
let adminUser = null
let superAdminUser = null
let cashierUser = null
let adminToken = null
let superAdminToken = null
let cashierToken = null
let adminOtherToken = null

const openRegister = (token, body = {}) =>
  request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${token}`)
    .send({ openingBalance: 100000, shift: 1, ...body })

const closeRegister = (token, id, body = {}) =>
  request(app)
    .put(`/cash-register/close/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ closingBalance: 100000, ...body })

const createMovement = (token, registerId, body) =>
  request(app)
    .post(`/cash-register/${registerId}/movement`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)

const decideMovement = (token, movementId, decision) =>
  request(app)
    .post(`/cash-register/movement/${movementId}/decide`)
    .set('Authorization', `Bearer ${token}`)
    .send({ decision })

const reverseMovement = (token, movementId, body = {}) =>
  request(app)
    .post(`/cash-register/movement/${movementId}/reverse`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)

const decideVariance = (token, registerId, decision) =>
  request(app)
    .put(`/cash-register/${registerId}/decide-variance`)
    .set('Authorization', `Bearer ${token}`)
    .send({ decision })

// G-02 (DR-23 §D): a non-cash counter sale carries its transaction reference.
const nonCashRef = (overrides) =>
  overrides.paymentMethod && overrides.paymentMethod !== 'cash' && !('referenceNumber' in overrides)
    ? { referenceNumber: `CL-REF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
    : {}

const cashOrder = (token, overrides = {}) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${token}`)
    .send(withIdempotencyKey({
      store: store.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'Cash Ledger Test Cashier',
      ...nonCashRef(overrides),
      ...overrides
    }))

beforeAll(async () => {
  store = await db.location.create({ name: 'CASH_LEDGER_STORE', status: 'active' })
  storeOther = await db.location.create({ name: 'CASH_LEDGER_STORE_OTHER', status: 'active' })
  category = await db.category.create({ name: 'CASH_LEDGER_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'CASH_LEDGER_PRODUCT',
    category: category.id,
    price: 100000,
    stock: 500
  })
  // getEffectiveStock() prioritizes product_store_stock over product.stock
  // whenever a per-store row exists — the first checkout's atomic upsert
  // creates one starting at 0, which then floors every later order to
  // "0 available" unless seeded explicitly (same pattern as
  // pos-stock-flows.test.js's own fixture setup).
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 500 })
  // getActiveTaxRate() defaults to 11% (PPN) when no store override exists —
  // confirmed by direct repro. Every accounting assertion in this file
  // needs a predictable, flat total, so override it to 0% for this store.
  await db.taxConfig.create({
    store: store.id,
    name: 'CASH_LEDGER_NO_TAX',
    rate: 0,
    type: 'ppn',
    status: 'active'
  })

  adminUser = await db.user.create({
    userName: 'admin_cash_ledger',
    email: 'admin_cash_ledger@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  superAdminUser = await db.user.create({
    userName: 'superadmin_cash_ledger',
    email: 'superadmin_cash_ledger@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active'
  })
  cashierUser = await db.user.create({
    userName: 'cashier_cash_ledger',
    email: 'cashier_cash_ledger@test.com',
    roleType: 'kasir',
    userType: 'kasir',
    store: store.id,
    status: 'active'
  })
  const adminOtherUser = await db.user.create({
    userName: 'admin_cash_ledger_other',
    email: 'admin_cash_ledger_other@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeOther.id,
    status: 'active'
  })

  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  superAdminToken = await signSessionToken(
    { id: superAdminUser.id, userName: superAdminUser.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
  cashierToken = await signSessionToken(
    { id: cashierUser.id, userName: cashierUser.userName, roleType: 'kasir', store: store.id },
    JWT_SECRET
  )
  adminOtherToken = await signSessionToken(
    { id: adminOtherUser.id, userName: adminOtherUser.userName, roleType: 'admin', store: storeOther.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.auditLog.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true, __auditMaintenance: true })
  await db.cashMovement.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true })
  await db.best_selling.destroy({ where: { productId: product?.id }, force: true })
  await db.cashRegister.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true })
  await db.expense.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({
    where: { id: [adminUser?.id, superAdminUser?.id, cashierUser?.id].filter(Boolean) },
    force: true
  })
  await db.user.destroy({ where: { store: storeOther?.id }, force: true })
  await db.location.destroy({ where: { id: [store?.id, storeOther?.id] }, force: true })
})

// Ensure no register is left open for `store` between tests that open one.
afterEach(async () => {
  await db.cashRegister.update(
    { status: 'closed', closedAt: new Date() },
    { where: { store: store.id, status: 'open' } }
  )
})

describe('Register lifecycle — open/close', () => {
  test('open creates a register; close computes and persists expectedCash/variance', async () => {
    const openRes = await openRegister(adminToken)
    expect(openRes.status).toBe(201)
    const registerId = openRes.body.data.id

    const closeRes = await closeRegister(adminToken, registerId, { closingBalance: 100000 })
    expect(closeRes.status).toBe(200)
    expect(closeRes.body.data.summary.variance).toBe(0)
    expect(closeRes.body.data.summary.varianceApprovalStatus).toBe('auto_approved')

    const fresh = await db.cashRegister.findByPk(registerId)
    expect(fresh.status).toBe('closed')
    expect(fresh.variance).toBe(0)
  })

  test('a second open for the same store is rejected with 400 (fast path)', async () => {
    const first = await openRegister(adminToken)
    expect(first.status).toBe(201)

    const second = await openRegister(adminToken)
    expect(second.status).toBe(400)

    await closeRegister(adminToken, first.body.data.id)
  })

  test('the DB-level partial unique index rejects a concurrent duplicate open register (model-level, bypassing the controller fast path)', async () => {
    const openedAt = new Date()
    const first = await db.cashRegister.create({
      store: store.id,
      user: adminUser.id,
      status: 'open',
      openingBalance: 0,
      openedAt
    })

    await expect(
      db.cashRegister.create({
        store: store.id,
        user: adminUser.id,
        status: 'open',
        openingBalance: 0,
        openedAt
      })
    ).rejects.toThrow()

    await first.update({ status: 'closed', closedAt: new Date() })
  })

  test('two concurrent register opens for the same store: exactly one succeeds', async () => {
    const [r1, r2] = await Promise.all([openRegister(adminToken), openRegister(adminToken)])
    // Numeric ascending sort — 201 always sorts before 400/409, so the
    // winner is index 0 and the loser (caught either by the fast-path
    // pre-check with 400, or the DB constraint violation with 409) is
    // index 1; both are correct, deterministic outcomes.
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses[0]).toBe(201)
    expect(statuses[1]).toBeGreaterThanOrEqual(400)
    expect([400, 409]).toContain(statuses[1])
    const winner = r1.status === 201 ? r1 : r2
    await closeRegister(adminToken, winner.body.data.id)
  })

  test('closing an already-closed register returns 404, not a duplicate close', async () => {
    const open = await openRegister(adminToken)
    const first = await closeRegister(adminToken, open.body.data.id)
    expect(first.status).toBe(200)

    const second = await closeRegister(adminToken, open.body.data.id)
    expect(second.status).toBe(404)
  })

  test('a super_admin request for GET /cash-register/current does not throw even with no open register', async () => {
    const res = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .query({ store: store.id })
    expect(res.status).toBe(200)
  })
})

describe('Cash movement — state machine', () => {
  let registerId

  beforeEach(async () => {
    const open = await openRegister(adminToken)
    registerId = open.body.data.id
  })

  test('cash_in is created directly active, no approval gate', async () => {
    const res = await createMovement(adminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 50000
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('active')
  })

  test('cash_out below the default threshold (500000) is active immediately', async () => {
    const res = await createMovement(adminToken, registerId, {
      type: 'cash_out',
      reasonCode: 'bank_drop',
      amount: 100000
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('active')
  })

  test('cash_out above the default threshold is pending_approval', async () => {
    const res = await createMovement(adminToken, registerId, {
      type: 'cash_out',
      reasonCode: 'bank_drop',
      amount: 600000
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('pending_approval')
  })

  test('approve transitions pending_approval to active and sets approvedBy/approvedAt', async () => {
    const created = await createMovement(adminToken, registerId, {
      type: 'cash_out',
      reasonCode: 'owner_draw',
      amount: 700000
    })
    const res = await decideMovement(adminToken, created.body.data.id, 'approve')
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.approvedBy).toBe(adminUser.id)
    expect(res.body.data.approvedAt).toBeTruthy()
  })

  test('reject transitions pending_approval to rejected, terminal', async () => {
    const created = await createMovement(adminToken, registerId, {
      type: 'cash_out',
      reasonCode: 'owner_draw',
      amount: 700000
    })
    const res = await decideMovement(adminToken, created.body.data.id, 'reject')
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('rejected')

    const again = await decideMovement(adminToken, created.body.data.id, 'approve')
    expect(again.status).toBe(409)
  })

  test('reverse flips the original to reversed and creates a new opposite-type active movement', async () => {
    const created = await createMovement(adminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 30000
    })
    const res = await reverseMovement(adminToken, created.body.data.id)
    expect(res.status).toBe(201)
    expect(res.body.data.type).toBe('cash_out')
    expect(res.body.data.reversalOfId).toBe(created.body.data.id)
    expect(res.body.data.status).toBe('active')

    const original = await db.cashMovement.findByPk(created.body.data.id)
    expect(original.status).toBe('reversed')
  })

  test('invalid transition: reversing a pending_approval movement is rejected 409', async () => {
    const created = await createMovement(adminToken, registerId, {
      type: 'cash_out',
      reasonCode: 'owner_draw',
      amount: 900000
    })
    const res = await reverseMovement(adminToken, created.body.data.id)
    expect(res.status).toBe(409)
  })

  test('invalid transition: approving an already-active movement is rejected 409', async () => {
    const created = await createMovement(adminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 10000
    })
    const res = await decideMovement(adminToken, created.body.data.id, 'approve')
    expect(res.status).toBe(409)
  })

  test('idempotency: repeated request with the same key returns the original movement, 200 not 201', async () => {
    const key = `idem-${Date.now()}-${Math.random()}`
    const first = await createMovement(adminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 25000,
      idempotencyKey: key
    })
    expect(first.status).toBe(201)

    const second = await createMovement(adminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 25000,
      idempotencyKey: key
    })
    expect(second.status).toBe(200)
    expect(second.body.data.id).toBe(first.body.data.id)

    const count = await db.cashMovement.count({ where: { cashRegisterId: registerId, idempotencyKey: key } })
    expect(count).toBe(1)
  })

  test('concurrent duplicate creation with the same idempotency key never produces two rows', async () => {
    const key = `idem-concurrent-${Date.now()}-${Math.random()}`
    const [r1, r2] = await Promise.all([
      createMovement(adminToken, registerId, {
        type: 'cash_in',
        reasonCode: 'float_topup',
        amount: 15000,
        idempotencyKey: key
      }),
      createMovement(adminToken, registerId, {
        type: 'cash_in',
        reasonCode: 'float_topup',
        amount: 15000,
        idempotencyKey: key
      })
    ])
    expect([r1.status, r2.status].every((s) => s === 200 || s === 201)).toBe(true)
    const count = await db.cashMovement.count({ where: { cashRegisterId: registerId, idempotencyKey: key } })
    expect(count).toBe(1)
  })

  test('422: amount <= 0 is rejected as semantic validation, not 400', async () => {
    const res = await createMovement(adminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 0
    })
    expect(res.status).toBe(422)
  })

  test('422: reasonCode=other without notes is rejected', async () => {
    const res = await createMovement(adminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'other',
      amount: 10000
    })
    expect(res.status).toBe(422)
  })
})

describe('Register-close serialization (P1-01 / P1-04)', () => {
  test('movement creation against an already-closed register deterministically returns 409', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id
    await closeRegister(adminToken, registerId)

    const res = await createMovement(adminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 10000
    })
    expect(res.status).toBe(409)

    const count = await db.cashMovement.count({ where: { cashRegisterId: registerId } })
    expect(count).toBe(0)
  })

  test('reversing an active movement after its register has closed returns 409 — the realistic, reachable case', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id
    const created = await createMovement(adminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 20000
    })
    expect(created.body.data.status).toBe('active')

    await closeRegister(adminToken, registerId)

    const res = await reverseMovement(adminToken, created.body.data.id)
    expect(res.status).toBe(409)

    const stillActive = await db.cashMovement.findByPk(created.body.data.id)
    expect(stillActive.status).toBe('active')
  })

  test('approving a pending movement after the register was force-closed out-of-band returns 409 (defense-in-depth — normally unreachable via the API since close() blocks on pending movements)', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id
    const created = await createMovement(adminToken, registerId, {
      type: 'cash_out',
      reasonCode: 'owner_draw',
      amount: 900000
    })
    expect(created.body.data.status).toBe('pending_approval')

    // Force-close directly at the model level, bypassing the pending-count
    // guard, specifically to prove decideMovement's own independent
    // register-open check works in isolation.
    await db.cashRegister.update({ status: 'closed', closedAt: new Date() }, { where: { id: registerId } })

    const res = await decideMovement(adminToken, created.body.data.id, 'approve')
    expect(res.status).toBe(409)
  })

  test('close is blocked (409) while a pending_approval movement exists, and the register stays open', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id
    await createMovement(adminToken, registerId, {
      type: 'cash_out',
      reasonCode: 'owner_draw',
      amount: 900000
    })

    const closeRes = await closeRegister(adminToken, registerId)
    expect(closeRes.status).toBe(409)

    const fresh = await db.cashRegister.findByPk(registerId)
    expect(fresh.status).toBe('open')
  })

  test('simultaneous close + movement creation on the same register: the movement never lands against an already-committed closed register', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id

    const [closeRes, moveRes] = await Promise.all([
      closeRegister(adminToken, registerId),
      createMovement(adminToken, registerId, {
        type: 'cash_in',
        reasonCode: 'float_topup',
        amount: 10000
      })
    ])

    if (moveRes.status === 201) {
      // The movement won the register lock first — close must then see the
      // register still open at that moment; whichever of close's two
      // possible outcomes occurred, the persisted state must be self-
      // consistent: the movement row must exist and be active.
      const mv = await db.cashMovement.findOne({ where: { cashRegisterId: registerId } })
      expect(mv).not.toBeNull()
      expect(mv.status).toBe('active')
    } else {
      // Close won the register lock first — the movement must have been
      // deterministically rejected, never partially applied.
      expect(moveRes.status).toBe(409)
      const count = await db.cashMovement.count({ where: { cashRegisterId: registerId } })
      expect(count).toBe(0)
    }

    // Either way, the register ends up closed.
    const fresh = await db.cashRegister.findByPk(registerId)
    expect(fresh.status).toBe('closed')
  })

  test('closed-register variance is not mutated by a later, unrelated movement operation on a different register', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id
    const closeRes = await closeRegister(adminToken, registerId, { closingBalance: 150000 })
    const persistedVariance = closeRes.body.data.summary.variance

    // Unrelated activity on a fresh register for the same store.
    const open2 = await openRegister(adminToken)
    await createMovement(adminToken, open2.body.data.id, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 999999
    })
    await closeRegister(adminToken, open2.body.data.id)

    const fresh = await db.cashRegister.findByPk(registerId)
    expect(fresh.variance).toBe(persistedVariance)
  })
})

describe('Variance approval', () => {
  test('a variance within the default threshold (25000) auto-approves', async () => {
    const open = await openRegister(adminToken)
    const closeRes = await closeRegister(adminToken, open.body.data.id, { closingBalance: 110000 })
    expect(closeRes.body.data.summary.varianceApprovalStatus).toBe('auto_approved')
  })

  test('a variance beyond the threshold requires decision, and decideVariance does not reopen or alter variance', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id
    const closeRes = await closeRegister(adminToken, registerId, { closingBalance: 50000 })
    expect(closeRes.body.data.summary.varianceApprovalStatus).toBe('pending_approval')
    const persistedVariance = closeRes.body.data.summary.variance

    const decideRes = await decideVariance(superAdminToken, registerId, 'approve')
    expect(decideRes.status).toBe(200)
    expect(decideRes.body.data.varianceApprovalStatus).toBe('approved')

    const fresh = await db.cashRegister.findByPk(registerId)
    expect(fresh.status).toBe('closed')
    expect(fresh.variance).toBe(persistedVariance)
  })

  test('rejecting a variance does not reopen the register', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id
    await closeRegister(adminToken, registerId, { closingBalance: 50000 })

    const decideRes = await decideVariance(superAdminToken, registerId, 'reject')
    expect(decideRes.status).toBe(200)
    expect(decideRes.body.data.varianceApprovalStatus).toBe('rejected')

    const fresh = await db.cashRegister.findByPk(registerId)
    expect(fresh.status).toBe('closed')
  })

  test('an admin (not super_admin) cannot decide variance', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id
    await closeRegister(adminToken, registerId, { closingBalance: 50000 })

    const res = await decideVariance(adminToken, registerId, 'approve')
    expect(res.status).toBe(403)
  })
})

describe('Cash tender invariant (P1-02)', () => {
  // P1 (DR-PAY-ATTR-02): counter collection requires an open register.
  // The file-level afterEach force-closes registers, so each tender test
  // opens its own; tender-math assertions are unchanged.
  beforeEach(async () => {
    await openRegister(adminToken, { openingBalance: 0 })
  })

  test('exact cash tender (no explicit fields) falls back to cashReceived=amountDue, changeGiven=0', async () => {
    const res = await cashOrder(cashierToken)
    expect(res.status).toBe(201)
    const txn = await db.transaction.findOne({ where: { order: res.body.data.id } })
    expect(txn.cashReceived).toBe(100000)
    expect(txn.changeGiven).toBe(0)
  })

  test('valid cash with change is accepted and persisted exactly', async () => {
    const res = await cashOrder(cashierToken, { cashAmount: 150000, changeAmount: 50000 })
    expect(res.status).toBe(201)
    const txn = await db.transaction.findOne({ where: { order: res.body.data.id } })
    expect(txn.cashReceived).toBe(150000)
    expect(txn.changeGiven).toBe(50000)
  })

  test('cashAmount below amountDue is rejected 422', async () => {
    const res = await cashOrder(cashierToken, { cashAmount: 50000, changeAmount: 0 })
    expect(res.status).toBe(422)
  })

  test('negative changeAmount is rejected 422', async () => {
    const res = await cashOrder(cashierToken, { cashAmount: 100000, changeAmount: -10 })
    expect(res.status).toBe(422)
  })

  test('incorrect arithmetic (cashAmount - changeAmount != amountDue) is rejected 422', async () => {
    const res = await cashOrder(cashierToken, { cashAmount: 150000, changeAmount: 20000 })
    expect(res.status).toBe(422)
  })

  test('only cashAmount supplied, changeAmount omitted, is rejected 422', async () => {
    const res = await cashOrder(cashierToken, { cashAmount: 150000 })
    expect(res.status).toBe(422)
  })

  test('only changeAmount supplied, cashAmount omitted, is rejected 422', async () => {
    const res = await cashOrder(cashierToken, { changeAmount: 0 })
    expect(res.status).toBe(422)
  })

  test('non-cash payment with cash fields supplied is rejected 422', async () => {
    const res = await cashOrder(cashierToken, {
      paymentMethod: 'qris',
      cashAmount: 100000,
      changeAmount: 0
    })
    expect(res.status).toBe(422)
  })

  test('non-cash payment with no cash fields persists cashReceived=null, changeGiven=0', async () => {
    const res = await cashOrder(cashierToken, { paymentMethod: 'qris' })
    expect(res.status).toBe(201)
    const txn = await db.transaction.findOne({ where: { order: res.body.data.id } })
    expect(txn.cashReceived).toBeNull()
    expect(txn.changeGiven).toBe(0)
  })

  test('a rejected cash-tender order does not persist any order/transaction row', async () => {
    const before = await db.order.count({ where: { store: store.id } })
    const res = await cashOrder(cashierToken, { cashAmount: 1, changeAmount: 0 })
    expect(res.status).toBe(422)
    const after = await db.order.count({ where: { store: store.id } })
    expect(after).toBe(before)
  })
})

describe('Accounting — expectedCash / cashSalesReceived / expense attribution', () => {
  test('150000 cashReceived, 50000 changeGiven, 100000 amount due produces cashSalesReceived = 100000', async () => {
    const open = await openRegister(adminToken, { openingBalance: 0 })
    const registerId = open.body.data.id

    // Product price is 100000 (server-recomputed regardless of any client
    // price hint), tendered 150000, 50000 change.
    const orderRes = await cashOrder(cashierToken, { cashAmount: 150000, changeAmount: 50000 })
    expect(orderRes.status).toBe(201)
    expect(orderRes.body.data.cashRegisterId).toBe(registerId)

    const current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(current.body.data.cashSalesReceived).toBe(100000)

    await closeRegister(adminToken, registerId)
  })

  test('mixed cash + non-cash sales: cashSalesReceived reflects only the cash portion', async () => {
    const open = await openRegister(adminToken, { openingBalance: 0 })
    const registerId = open.body.data.id

    await cashOrder(cashierToken) // cash, 100000
    await cashOrder(cashierToken, { paymentMethod: 'qris' }) // non-cash, 100000

    const current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(current.body.data.cashSalesReceived).toBe(100000)

    await closeRegister(adminToken, registerId)
  })

  test('cash-in and cash-out are correctly reflected in expectedCash', async () => {
    const open = await openRegister(adminToken, { openingBalance: 100000 })
    const registerId = open.body.data.id

    await createMovement(adminToken, registerId, { type: 'cash_in', reasonCode: 'float_topup', amount: 30000 })
    await createMovement(adminToken, registerId, { type: 'cash_out', reasonCode: 'bank_drop', amount: 20000 })

    const current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    // 100000 opening + 30000 in - 20000 out + 0 cash sales - 0 expenses
    expect(current.body.data.expectedCash).toBe(110000)

    await closeRegister(adminToken, registerId)
  })

  test('a pending_approval cash-out does NOT reduce expectedCash until approved', async () => {
    const open = await openRegister(adminToken, { openingBalance: 100000 })
    const registerId = open.body.data.id

    const created = await createMovement(adminToken, registerId, {
      type: 'cash_out',
      reasonCode: 'owner_draw',
      amount: 600000
    })
    expect(created.body.data.status).toBe('pending_approval')

    let current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(current.body.data.expectedCash).toBe(100000) // unaffected while pending

    await decideMovement(adminToken, created.body.data.id, 'approve')

    current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(current.body.data.expectedCash).toBe(100000 - 600000)

    await createMovement(adminToken, registerId, { type: 'cash_in', reasonCode: 'float_topup', amount: 600000 })
    await closeRegister(adminToken, registerId)
  })

  test('a reversed movement no longer contributes to expectedCash', async () => {
    const open = await openRegister(adminToken, { openingBalance: 100000 })
    const registerId = open.body.data.id

    const created = await createMovement(adminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 50000
    })
    let current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(current.body.data.expectedCash).toBe(150000)

    await reverseMovement(adminToken, created.body.data.id)

    current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    // The original cash_in becomes 'reversed' (excluded, contributes 0 —
    // not -50000). The reversal itself is a fresh, real 'active' cash_out
    // of the same amount, which DOES count. Net: 100000 opening - 50000
    // (the reversal's own cash_out) = 50000 — reversal is an explicit
    // opposite correction, not a no-op that restores the pre-original
    // baseline. This is the approved F2 design, not a bug.
    expect(current.body.data.expectedCash).toBe(50000)

    await closeRegister(adminToken, registerId)
  })

  test('an approved cash expense reduces expectedCash regardless of who created it (createdBy filter removed)', async () => {
    const open = await openRegister(adminToken, { openingBalance: 100000 })
    const registerId = open.body.data.id

    // Created by superAdminUser, NOT the register's opener (adminUser) —
    // direct regression test for Finding 6's fix.
    await db.expense.create({
      store: store.id,
      expenseNumber: `EXP-${Date.now()}`,
      amount: 15000,
      date: new Date(),
      paymentMethod: 'cash',
      status: 'approved',
      createdBy: superAdminUser.id
    })

    const current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(current.body.data.expectedCash).toBe(85000)

    await closeRegister(adminToken, registerId)
  })

  test('expense.date outside the window but createdAt inside it IS included (formula uses createdAt)', async () => {
    const open = await openRegister(adminToken, { openingBalance: 100000 })
    const registerId = open.body.data.id
    const now = new Date()

    await db.expense.create({
      store: store.id,
      expenseNumber: `EXP-${Date.now()}-A`,
      amount: 10000,
      date: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
      createdAt: now,
      paymentMethod: 'cash',
      status: 'approved',
      createdBy: adminUser.id
    })

    const current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(current.body.data.expectedCash).toBe(90000)

    await closeRegister(adminToken, registerId)
  })

  test('expense.date inside the window but createdAt outside it is EXCLUDED (formula uses createdAt, not date)', async () => {
    const open = await openRegister(adminToken, { openingBalance: 100000 })
    const registerId = open.body.data.id
    const openedAt = (await db.cashRegister.findByPk(registerId)).openedAt

    await db.expense.create({
      store: store.id,
      expenseNumber: `EXP-${Date.now()}-B`,
      amount: 10000,
      date: new Date(), // "now" — inside the window by date
      createdAt: new Date(new Date(openedAt).getTime() - 30 * 24 * 60 * 60 * 1000), // 30 days before open, by createdAt
      paymentMethod: 'cash',
      status: 'approved',
      createdBy: adminUser.id
    })

    const current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(current.body.data.expectedCash).toBe(100000) // unaffected

    await closeRegister(adminToken, registerId)
  })

  test('a non-cash-paid approved expense does not reduce expectedCash', async () => {
    const open = await openRegister(adminToken, { openingBalance: 100000 })
    const registerId = open.body.data.id

    await db.expense.create({
      store: store.id,
      expenseNumber: `EXP-${Date.now()}-C`,
      amount: 10000,
      date: new Date(),
      paymentMethod: 'bank',
      status: 'approved',
      createdBy: adminUser.id
    })

    const current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(current.body.data.expectedCash).toBe(100000)

    await closeRegister(adminToken, registerId)
  })

  test('totalSales stays the pre-F2 gross figure across all payment methods, distinct from cashSalesReceived', async () => {
    const open = await openRegister(adminToken, { openingBalance: 0 })
    const registerId = open.body.data.id

    // totalSales' pre-existing (deliberately unchanged) query filters by
    // "createdBy = register.user" — the register's OPENER, not just
    // anyone. Using adminToken (the opener) for both orders here so that
    // pre-existing, preserved behavior is exercised correctly; using
    // cashierToken would legitimately show totalSales=0 for this specific
    // register, which is the existing limitation Finding 7 documents and
    // deliberately does not change — not what this test is about.
    await cashOrder(adminToken) // 100000 cash
    await cashOrder(adminToken, { paymentMethod: 'qris' }) // 100000 qris

    const closeRes = await closeRegister(adminToken, registerId)
    expect(closeRes.body.data.summary.totalSales).toBe(200000) // gross, both methods
    expect(closeRes.body.data.summary.cashSalesReceived).toBe(100000) // cash only
  })
})

describe('Tenant isolation', () => {
  test('cross-store register access (close) returns 404', async () => {
    const open = await openRegister(adminToken)
    const res = await closeRegister(adminOtherToken, open.body.data.id)
    expect(res.status).toBe(404)
    await closeRegister(adminToken, open.body.data.id)
  })

  test('cross-store movement access (decide) returns 404', async () => {
    const open = await openRegister(adminToken)
    const created = await createMovement(adminToken, open.body.data.id, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 10000
    })
    const res = await decideMovement(adminOtherToken, created.body.data.id, 'approve')
    expect(res.status).toBe(404)
    await closeRegister(adminToken, open.body.data.id)
  })

  test('cross-store movement creation (wrong-store admin targeting this store\'s register) returns 404', async () => {
    const open = await openRegister(adminToken)
    const res = await createMovement(adminOtherToken, open.body.data.id, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 10000
    })
    expect(res.status).toBe(404)
    await closeRegister(adminToken, open.body.data.id)
  })

  test('a client-supplied store field in the movement request body cannot alter the persisted store — it is never even read', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id

    // Using super_admin specifically: validateStoreAccess already rejects
    // a mismatched `store` in the body for non-super-admin roles (403,
    // confirmed separately) — super_admin is the one caller that CAN get
    // a mismatched store claim past that middleware, so it's the
    // meaningful case for proving the controller itself never reads
    // req.body.store (createMovement's destructure doesn't include it).
    const res = await createMovement(superAdminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 10000,
      store: storeOther.id // deliberately wrong/malicious
    })
    expect(res.status).toBe(201)

    const persisted = await db.cashMovement.findByPk(res.body.data.id)
    expect(persisted.store).toBe(store.id)
    expect(persisted.store).not.toBe(storeOther.id)

    await closeRegister(adminToken, registerId)
  })
})

describe('Migration integrity', () => {
  test('cash_movement.store NOT NULL is enforced', async () => {
    const open = await openRegister(adminToken)
    await expect(
      db.cashMovement.create({
        cashRegisterId: open.body.data.id,
        type: 'cash_in',
        reasonCode: 'float_topup',
        amount: 1000,
        status: 'active'
      })
    ).rejects.toThrow()
    await closeRegister(adminToken, open.body.data.id)
  })

  test('deleting a location with cash_movement history is blocked by ON DELETE RESTRICT', async () => {
    const tempLocation = await db.location.create({ name: 'CASH_LEDGER_FK_TEST', status: 'active' })
    const reg = await db.cashRegister.create({
      store: tempLocation.id,
      user: adminUser.id,
      status: 'open',
      openingBalance: 0,
      openedAt: new Date()
    })
    await db.cashMovement.create({
      store: tempLocation.id,
      cashRegisterId: reg.id,
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 1000,
      status: 'active'
    })

    await expect(db.location.destroy({ where: { id: tempLocation.id }, force: true })).rejects.toThrow()

    await db.cashMovement.destroy({ where: { cashRegisterId: reg.id }, force: true })
    await db.cashRegister.destroy({ where: { id: reg.id }, force: true })
    await db.location.destroy({ where: { id: tempLocation.id }, force: true })
  })
})

describe('Backward compatibility', () => {
  test('a historical order with cashRegisterId=NULL is excluded from every register\'s expectedCash', async () => {
    const open = await openRegister(adminToken, { openingBalance: 0 })
    const registerId = open.body.data.id

    // Simulate a pre-F2 order: paid, cash, but never attributed to any
    // register (bypasses the API, direct model creation).
    const historicalOrder = await db.order.create({
      orderNumber: `HIST-${Date.now()}`,
      store: store.id,
      status: 'paid',
      paymentStatus: 'paid',
      paymentMethod: 'cash',
      totalPrice: 999999,
      cashRegisterId: null,
      createdBy: cashierUser.id
    })
    await db.transaction.create({
      order: historicalOrder.id,
      typePayment: 'cash',
      amount: 999999,
      cashReceived: 999999,
      changeGiven: 0,
      createdBy: cashierUser.id
    })

    const current = await request(app)
      .get('/cash-register/current')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(current.body.data.cashSalesReceived).toBe(0)

    await db.transaction.destroy({ where: { order: historicalOrder.id }, force: true })
    await db.order.destroy({ where: { id: historicalOrder.id }, force: true })
    await closeRegister(adminToken, registerId)
  })

  test('an order created with no open register present is refused with 422 and persists nothing', async () => {
    // P1 (DR-PAY-ATTR-02) supersedes the old null-register tolerance:
    // no open register for `store` at this point (afterEach closes any).
    const before = await db.order.count({ where: { store: store.id } })
    const res = await cashOrder(cashierToken)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('REGISTER_REQUIRED')
    expect(await db.order.count({ where: { store: store.id } })).toBe(before)
  })

  test('old-shape checkout requests (no cashAmount/changeAmount at all) continue to work exactly as before', async () => {
    await openRegister(adminToken, { openingBalance: 0 })
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: store.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'Legacy Client'
      }))
    expect(res.status).toBe(201)
  })
})
