process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// FP-01 Test D (endpoint-level): when the audit write for a variance
// decision fails, PUT /cash-register/:id/decide-variance must not report
// success — the decision must remain pending and no decision audit row
// may be committed. Failure injection is a narrowly scoped
// jest.spyOn(db.auditLog, 'create') that rejects only the decision audit
// for this register and calls through for every other write; the spy is
// process-local (other suites run in separate processes) and restored in
// a finally block. Uses the isolated test database with disposable
// fixtures. Never touches real data.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const P = 'FP01_D_'

let store = null
let adminUser = null
let superAdminUser = null
let adminToken = null
let superAdminToken = null

beforeAll(async () => {
  store = await db.location.create({ name: `${P}STORE`, status: 'active' })
  adminUser = await db.user.create({
    userName: `${P}ADMIN`.toLowerCase(),
    email: `${P}admin@test.com`.toLowerCase(),
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  superAdminUser = await db.user.create({
    userName: `${P}SUPERADMIN`.toLowerCase(),
    email: `${P}superadmin@test.com`.toLowerCase(),
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
  await db.auditLog.destroy({
    where: { description: { [db.Sequelize.Op.like]: `${P}%` } },
    force: true,
    __auditMaintenance: true
  })
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

describe('FP-01 endpoint: decideVariance with failing audit write', () => {
  test('audit failure returns non-2xx, decision stays pending, no decision audit is committed', async () => {
    const openRes = await request(app)
      .post('/cash-register/open')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ openingBalance: 100000, shift: 1 })
    expect(openRes.status).toBe(201)
    const registerId = openRes.body.data.id

    const closeRes = await request(app)
      .put(`/cash-register/close/${registerId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ closingBalance: 50000 })
    expect(closeRes.status).toBe(200)
    expect(closeRes.body.data.summary.varianceApprovalStatus).toBe('pending_approval')

    const before = await db.cashRegister.findByPk(registerId)
    expect(before.status).toBe('closed')
    expect(before.varianceApprovalStatus).toBe('pending_approval')

    const origCreate = db.auditLog.create.bind(db.auditLog)
    const spy = jest.spyOn(db.auditLog, 'create').mockImplementation((values, options) => {
      if (values && values.entity === 'cash_register' && values.entityId === registerId) {
        return Promise.reject(new Error(`${P}audit failure probe`))
      }
      return origCreate(values, options)
    })
    let decideRes
    try {
      decideRes = await request(app)
        .put(`/cash-register/${registerId}/decide-variance`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ decision: 'approve' })
    } finally {
      spy.mockRestore()
    }

    // 1. Non-2xx: the probe error carries no statusCode, so the
    // controller's error translation yields 500.
    expect(decideRes.status).toBe(500)
    expect(decideRes.body.success).toBe(false)

    // 2-4. Owner transaction rolled back: decision still pending,
    // closure and financial figures unchanged.
    const fresh = await db.cashRegister.findByPk(registerId)
    expect(fresh.status).toBe('closed')
    expect(fresh.varianceApprovalStatus).toBe('pending_approval')
    expect(fresh.variance).toBe(before.variance)
    expect(fresh.expectedCash).toBe(before.expectedCash)
    expect(fresh.closingBalance).toBe(before.closingBalance)

    // 3. No decision audit row committed for this register.
    expect(
      await db.auditLog.count({
        where: { entity: 'cash_register', entityId: registerId, action: ['approve', 'reject'] }
      })
    ).toBe(0)
  })
})
