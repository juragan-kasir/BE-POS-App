'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// The legacy endpoint shells out to python3; the guard tests never need that
// side effect, and the authorized-path test asserts the handler still runs.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process')
  return { ...actual, execSync: jest.fn(() => 'Printed') }
})

const request = require('supertest')
const { execSync } = require('child_process')
const app = require('../api/index')
const db = require('../db/models')
const { createAuthenticatedTestSession } = require('../test-helpers/authSession')

const PREFIX = `print_guard_${Date.now()}`
let store = null
let kasir = null
let admin = null
let staff = null
const createdUserIds = []

const bearer = (token) => ({ Authorization: `Bearer ${token}` })

const makeUser = async (key, roleType, userType) => {
  const out = await createAuthenticatedTestSession({
    userName: `${PREFIX}_${key}`,
    email: `${PREFIX}_${key}@test.com`,
    password: 'Test12345!',
    fullName: `${PREFIX} ${key}`,
    userType,
    roleType,
    status: 'active',
    store: store.id
  })
  createdUserIds.push(out.user.id)
  return out
}

beforeAll(async () => {
  store = await db.location.create({ name: `${PREFIX}_STORE`, status: 'active' })
  kasir = await makeUser('kasir', 'kasir', 'kasir')
  admin = await makeUser('admin', 'admin', 'admin')
  staff = await makeUser('staff', 'user', 'user')
})

afterAll(async () => {
  if (createdUserIds.length) {
    await db.authorizationContextSession
      .destroy({ where: { userId: createdUserIds }, force: true })
      .catch(() => {})
    await db.user
      .destroy({ where: { id: createdUserIds }, force: true })
      .catch(() => {})
  }
  await db.location
    .destroy({ where: { id: store?.id }, force: true })
    .catch(() => {})
})

describe('POST /print-thermal — authentication guard', () => {
  test('rejects a request without a credential', async () => {
    const res = await request(app).post('/print-thermal').send({})
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('User Belum Login')
  })

  test('rejects a forged bearer token', async () => {
    const res = await request(app)
      .post('/print-thermal')
      .set('Authorization', 'Bearer definitely-not-a-jwt')
      .send({})
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Token Tidak Valid')
  })

  test('rejects an authenticated role that may not print', async () => {
    const res = await request(app)
      .post('/print-thermal')
      .set(bearer(staff.token))
      .send({})
    expect(res.status).toBe(403)
  })

  test('lets a cashier through the guard', async () => {
    const res = await request(app)
      .post('/print-thermal')
      .set(bearer(kasir.token))
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.message).toBe('No receipt data')
  })

  test('lets an admin through the guard', async () => {
    const res = await request(app)
      .post('/print-thermal')
      .set(bearer(admin.token))
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.message).toBe('No receipt data')
  })

  test('prints when an authorized cashier sends receipt data', async () => {
    execSync.mockClear()
    const res = await request(app)
      .post('/print-thermal')
      .set(bearer(kasir.token))
      .send({ data: { items: [], total: 0 } })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(execSync).toHaveBeenCalledTimes(1)
  })
})
