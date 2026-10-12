process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BE-1: cash-variance decision concurrency regression.
// The decide-variance endpoint must serialize two concurrent decisions on
// the same pending_approval register so exactly one wins. Uses real HTTP
// round trips (supertest) + real Postgres, fired together via Promise.all
// (synchronization barrier — both requests in flight simultaneously, not
// sequential), not arbitrary sleeps.

let store = null
let adminUser = null
let superAdminUser = null
let adminToken = null
let superAdminToken = null

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

const decideVariance = (token, registerId, decision) =>
  request(app)
    .put(`/cash-register/${registerId}/decide-variance`)
    .set('Authorization', `Bearer ${token}`)
    .send({ decision })

const makePendingRegister = async () => {
  const open = await openRegister(adminToken)
  expect(open.status).toBe(201)
  const registerId = open.body.data.id
  // closingBalance far from expectedCash (100000 opening, no sales) so
  // variance = -50000, abs > 25000 threshold => pending_approval.
  const closeRes = await closeRegister(adminToken, registerId, { closingBalance: 50000 })
  expect(closeRes.status).toBe(200)
  expect(closeRes.body.data.summary.varianceApprovalStatus).toBe('pending_approval')
  return registerId
}

beforeAll(async () => {
  store = await db.location.create({ name: 'BE1_VARIANCE_RACE_STORE', status: 'active' })
  adminUser = await db.user.create({
    userName: 'admin_be1_variance_race',
    email: 'admin_be1_variance_race@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  superAdminUser = await db.user.create({
    userName: 'superadmin_be1_variance_race',
    email: 'superadmin_be1_variance_race@test.com',
    roleType: 'super_admin',
    userType: 'admin',
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
})

afterAll(async () => {
  await db.auditLog.destroy({ where: { store: store?.id }, force: true, __auditMaintenance: true })
  await db.cashMovement.destroy({ where: { store: store?.id }, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store?.id }, force: true })
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.user.destroy({ where: { id: [adminUser?.id, superAdminUser?.id].filter(Boolean) }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

afterEach(async () => {
  await db.cashRegister.update(
    { status: 'closed', closedAt: new Date() },
    { where: { store: store.id, status: 'open' } }
  )
})

describe('BE-1 cash variance decision concurrency', () => {
  test('two concurrent opposite decisions: exactly one succeeds, loser gets 409, single audit, finances unchanged', async () => {
    const registerId = await makePendingRegister()

    const before = await db.cashRegister.findByPk(registerId)
    expect(before.status).toBe('closed')
    expect(before.varianceApprovalStatus).toBe('pending_approval')
    const snapshot = {
      variance: before.variance,
      expectedCash: before.expectedCash,
      closingBalance: before.closingBalance,
      openingBalance: before.openingBalance,
      totalSales: before.totalSales,
      cashSalesReceived: before.cashSalesReceived,
      status: before.status
    }

    // Synchronization barrier: both requests are constructed then fired
    // together — overlapping in flight, not sequential. Opposite decisions
    // so a double-success is observable as contradictory state.
    const approveReq = () => decideVariance(superAdminToken, registerId, 'approve')
    const rejectReq = () => decideVariance(superAdminToken, registerId, 'reject')
    const [r1, r2] = await Promise.all([approveReq(), rejectReq()])

    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    // Exactly one winner (200), exactly one loser (409). Two 200s is the
    // BE-1 race; two 409s would be a false rejection.
    expect(statuses).toEqual([200, 409])

    const winner = r1.status === 200 ? r1 : r2
    const loser = r1.status === 200 ? r2 : r1
    expect(winner.body.success).toBe(true)
    expect(loser.body.success).toBe(false)

    const fresh = await db.cashRegister.findByPk(registerId)
    expect(fresh.varianceApprovalStatus).toBe(winner.body.data.varianceApprovalStatus)
    expect(['approved', 'rejected']).toContain(fresh.varianceApprovalStatus)

    // Financial figures and closure state remain unchanged by the decision.
    expect(fresh.status).toBe('closed')
    expect(fresh.variance).toBe(snapshot.variance)
    expect(fresh.expectedCash).toBe(snapshot.expectedCash)
    expect(fresh.closingBalance).toBe(snapshot.closingBalance)
    expect(fresh.openingBalance).toBe(snapshot.openingBalance)
    expect(fresh.totalSales).toBe(snapshot.totalSales)
    // cashSalesReceived may be null/0 — compare loosely via Number when present.
    expect(Number(fresh.cashSalesReceived || 0)).toBe(Number(snapshot.cashSalesReceived || 0))

    // Exactly one decision audit event; no contradictory event from loser.
    const audits = await db.auditLog.findAll({
      where: { entity: 'cash_register', entityId: registerId, action: ['approve', 'reject'] }
    })
    expect(audits).toHaveLength(1)
    const auditAction = audits[0].action
    expect(['approve', 'reject']).toContain(auditAction)
    // Audit must match the winning decision.
    const expectedAction = winner.body.data.varianceApprovalStatus === 'approved' ? 'approve' : 'reject'
    expect(auditAction).toBe(expectedAction)

    // Subsequent retry against the decided register is a conflict.
    const retryDecision = fresh.varianceApprovalStatus === 'approved' ? 'reject' : 'approve'
    const retry = await decideVariance(superAdminToken, registerId, retryDecision)
    expect(retry.status).toBe(409)

    // No second audit was created by the retry.
    const auditsAfter = await db.auditLog.count({
      where: { entity: 'cash_register', entityId: registerId, action: ['approve', 'reject'] }
    })
    expect(auditsAfter).toBe(1)
  })

  test('concurrent decisions on different eligible registers do not block one another', async () => {
    const regA = await makePendingRegister()
    const regB = await makePendingRegister()
    expect(regA).not.toBe(regB)

    const [resA, resB] = await Promise.all([
      decideVariance(superAdminToken, regA, 'approve'),
      decideVariance(superAdminToken, regB, 'approve')
    ])

    // Row-level locking must not serialize unrelated registers into
    // conflicts — both should succeed independently.
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)

    const freshA = await db.cashRegister.findByPk(regA)
    const freshB = await db.cashRegister.findByPk(regB)
    expect(freshA.varianceApprovalStatus).toBe('approved')
    expect(freshB.varianceApprovalStatus).toBe('approved')

    const countA = await db.auditLog.count({
      where: { entity: 'cash_register', entityId: regA, action: ['approve', 'reject'] }
    })
    const countB = await db.auditLog.count({
      where: { entity: 'cash_register', entityId: regB, action: ['approve', 'reject'] }
    })
    expect(countA).toBe(1)
    expect(countB).toBe(1)
  })
})
