process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store1 = null
let admin = null
let kasir = null
let employee = null
let boundSuper = null
let peerBoundSuper = null
let globalSuper = null
let adminToken = null
let kasirToken = null
let boundSuperToken = null
let peerBoundSuperToken = null
let globalSuperToken = null

beforeAll(async () => {
  store1 = await db.location.create({ name: 'PII_STORE_1', status: 'active' })

  admin = await db.user.create({
    id: 99401,
    userName: 'pii_admin',
    email: 'pii_admin@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store1.id,
    status: 'active',
    fullName: 'PII_ADMIN'
  })
  kasir = await db.user.create({
    id: 99402,
    userName: 'pii_kasir',
    email: 'pii_kasir@test.com',
    roleType: 'kasir',
    userType: 'admin',
    store: store1.id,
    status: 'active',
    fullName: 'PII_KASIR'
  })
  employee = await db.user.create({
    id: 99403,
    userName: 'pii_employee',
    email: 'secret.employee@test.com',
    phoneNumber: '081234567890',
    address: 'Secret Street 1',
    roleType: 'user',
    userType: 'user',
    store: store1.id,
    status: 'active',
    fullName: 'PII_EMPLOYEE',
    monthlySalary: 9000000,
    dailySalary: 300000
  })
  boundSuper = await db.user.create({
    id: 99404,
    userName: 'pii_bound_super',
    email: 'pii_bound_super@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: store1.id,
    status: 'active',
    fullName: 'PII_BOUND_SUPER'
  })
  peerBoundSuper = await db.user.create({
    id: 99405,
    userName: 'pii_peer_bound_super',
    email: 'pii_peer_bound_super@test.com',
    roleType: 'super_admin',
    userType: 'user',
    store: store1.id,
    status: 'active',
    fullName: 'PII_PEER_BOUND_SUPER'
  })
  globalSuper = await db.user.create({
    id: 99406,
    userName: 'pii_global_super',
    email: 'pii_global_super@test.com',
    roleType: 'super_admin',
    userType: 'user',
    store: null,
    status: 'active',
    fullName: 'PII_GLOBAL_SUPER'
  })

  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  kasirToken = await signSessionToken(
    { id: kasir.id, userName: kasir.userName, roleType: 'kasir', store: store1.id },
    JWT_SECRET
  )
  boundSuperToken = await signSessionToken(
    { id: boundSuper.id, userName: boundSuper.userName, roleType: 'super_admin', store: store1.id },
    JWT_SECRET
  )
  peerBoundSuperToken = await signSessionToken(
    { id: peerBoundSuper.id, userName: peerBoundSuper.userName, roleType: 'super_admin', store: store1.id },
    JWT_SECRET
  )
  globalSuperToken = await signSessionToken(
    { id: globalSuper.id, userName: globalSuper.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.user.destroy({
    where: { id: [99401, 99402, 99403, 99404, 99405, 99406] },
    force: true
  })
  await db.location.destroy({ where: { id: store1?.id }, force: true })
})

const ids = (body) => (body.data || []).map((row) => row.id)

describe('employee PII projection', () => {
  test('admin list keeps contact and payroll fields', async () => {
    const res = await request(app)
      .get('/employee/get-employee?limit=100')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    const row = res.body.data.find((r) => r.id === employee.id)
    expect(row.email).toBe('secret.employee@test.com')
    expect(row.phoneNumber).toBe('081234567890')
  })

  test('kasir list hides contact, address and salary fields', async () => {
    const res = await request(app)
      .get('/employee/get-employee?limit=100')
      .set('Authorization', `Bearer ${kasirToken}`)

    expect(res.status).toBe(200)
    const row = res.body.data.find((r) => r.id === employee.id)
    expect(row).toBeTruthy()
    expect(row.fullName).toBe('PII_EMPLOYEE')
    expect(row.email).toBeUndefined()
    expect(row.phoneNumber).toBeUndefined()
    expect(row.address).toBeUndefined()
    expect(row.monthlySalary).toBeUndefined()
    expect(row.dailySalary).toBeUndefined()
  })

  test('kasir detail hides the same fields', async () => {
    const res = await request(app)
      .get(`/employee/get-employee/${employee.id}`)
      .set('Authorization', `Bearer ${kasirToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.fullName).toBe('PII_EMPLOYEE')
    expect(res.body.data.email).toBeUndefined()
    expect(res.body.data.phoneNumber).toBeUndefined()
    expect(res.body.data.address).toBeUndefined()
    expect(res.body.data.monthlySalary).toBeUndefined()
  })
})

describe('employee deletion super_admin guard', () => {
  test('store-bound super_admin cannot delete another super_admin', async () => {
    const res = await request(app)
      .delete(`/employee/delete-employee/${peerBoundSuper.id}`)
      .set('Authorization', `Bearer ${boundSuperToken}`)

    expect(res.status).toBe(403)
    expect(await db.user.findByPk(peerBoundSuper.id)).not.toBeNull()
  })

  test('global super_admin cannot delete its own account', async () => {
    const res = await request(app)
      .delete(`/employee/delete-employee/${globalSuper.id}`)
      .set('Authorization', `Bearer ${globalSuperToken}`)

    expect(res.status).toBe(403)
    expect(await db.user.findByPk(globalSuper.id)).not.toBeNull()
  })
})
