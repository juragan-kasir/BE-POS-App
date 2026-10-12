process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Lists cash movements of one register (newest first) so operational UIs
// can display, approve, and reverse movements. Uses the isolated test
// database with disposable fixtures. Never touches real data.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store = null
let storeOther = null
let adminUser = null
let adminToken = null
let adminOtherToken = null

const openRegister = (token, body = {}) =>
  request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${token}`)
    .send({ openingBalance: 100000, shift: 1, ...body })

const createMovement = (token, registerId, body) =>
  request(app)
    .post(`/cash-register/${registerId}/movement`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)

const listMovements = (token, registerId) =>
  request(app)
    .get(`/cash-register/${registerId}/movements`)
    .set('Authorization', `Bearer ${token}`)

beforeAll(async () => {
  store = await db.location.create({ name: 'MVLIST_STORE', status: 'active' })
  storeOther = await db.location.create({ name: 'MVLIST_STORE_OTHER', status: 'active' })
  adminUser = await db.user.create({
    userName: 'admin_mvlist',
    email: 'admin_mvlist@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  const adminOtherUser = await db.user.create({
    userName: 'admin_mvlist_other',
    email: 'admin_mvlist_other@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeOther.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  adminOtherToken = await signSessionToken(
    { id: adminOtherUser.id, userName: adminOtherUser.userName, roleType: 'admin', store: storeOther.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.auditLog.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true, __auditMaintenance: true })
  await db.cashMovement.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true })
  await db.cashRegister.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true })
  await db.user.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true })
  await db.location.destroy({ where: { id: [store?.id, storeOther?.id] }, force: true })
})

afterEach(async () => {
  await db.cashRegister.update(
    { status: 'closed', closedAt: new Date() },
    { where: { store: [store.id, storeOther.id], status: 'open' } }
  )
})

describe('GET /cash-register/:id/movements', () => {
  test('unknown register returns 404', async () => {
    const res = await listMovements(adminToken, 999999999)
    expect(res.status).toBe(404)
    expect(res.body.success).toBe(false)
  })

  test('cross-store register is indistinguishable from missing (404)', async () => {
    const open = await openRegister(adminToken)
    const res = await listMovements(adminOtherToken, open.body.data.id)
    expect(res.status).toBe(404)
    await request(app)
      .put(`/cash-register/close/${open.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ closingBalance: 100000 })
  })

  test('empty movement list returns an empty array', async () => {
    const open = await openRegister(adminToken)
    const res = await listMovements(adminToken, open.body.data.id)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toEqual([])
  })

  test('returns created movements newest-first with ledger fields', async () => {
    const open = await openRegister(adminToken)
    const registerId = open.body.data.id
    const first = await createMovement(adminToken, registerId, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 30000
    })
    expect(first.status).toBe(201)
    const second = await createMovement(adminToken, registerId, {
      type: 'cash_out',
      reasonCode: 'bank_drop',
      amount: 20000
    })
    expect(second.status).toBe(201)

    const res = await listMovements(adminToken, registerId)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].id).toBe(second.body.data.id)
    expect(res.body.data[1].id).toBe(first.body.data.id)
    for (const row of res.body.data) {
      expect(row.cashRegisterId).toBe(registerId)
      expect(row.store).toBe(store.id)
      expect(['cash_in', 'cash_out']).toContain(row.type)
      expect(typeof row.amount).toBe('number')
      expect(typeof row.status).toBe('string')
    }
  })

  test('movements of other registers are excluded', async () => {
    const openA = await openRegister(adminToken)
    await createMovement(adminToken, openA.body.data.id, {
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 10000
    })
    await request(app)
      .put(`/cash-register/close/${openA.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ closingBalance: 100000 })
    const openB = await openRegister(adminToken)
    const res = await listMovements(adminToken, openB.body.data.id)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})
