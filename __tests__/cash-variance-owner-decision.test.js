process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

let store = null
let admin = null
let adminToken = null

const decideVariance = (id, decision) =>
  request(app)
    .put(`/cash-register/${id}/decide-variance`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ decision })

beforeAll(async () => {
  store = await db.location.create({
    name: `ADR01_VARIANCE_STORE_${SUFFIX}`,
    status: 'active'
  })
  admin = await db.user.create({
    userName: `admin_adr01_${SUFFIX}`,
    email: `admin_adr01_${SUFFIX}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'ADR01_ADMIN'
  })
  adminToken = await signSessionToken(
    {
      id: admin.id,
      userName: admin.userName,
      roleType: 'admin',
      store: store.id
    },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.auditLog.destroy({
    where: { store: store.id },
    force: true,
    __auditMaintenance: true
  })
  await db.cashMovement.destroy({ where: { store: store.id }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.user.destroy({ where: { id: admin.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

describe('ADR-01 — the store owner decides cash variance', () => {
  test('an admin can approve a pending variance for their own store', async () => {
    const open = await request(app)
      .post('/cash-register/open')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ openingBalance: 100000, shift: 1 })
    expect(open.status).toBe(201)

    const close = await request(app)
      .put(`/cash-register/close/${open.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ closingBalance: 50000 })
    expect(close.status).toBe(200)
    expect(close.body.data.summary.varianceApprovalStatus).toBe(
      'pending_approval'
    )

    const res = await decideVariance(open.body.data.id, 'approve')
    expect(res.status).toBe(200)

    const fresh = await db.cashRegister.findByPk(open.body.data.id)
    expect(fresh.varianceApprovalStatus).toBe('approved')
    expect(fresh.approvedBy).toBe(admin.id)
  })
})
