process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

// D8 regression: POST /auth/login must NOT disclose the credential verifier.
// Both login response branches (auth.js:404 for non-admin/user userType,
// auth.js:422 for admin/user userType) previously spread the full
// `findUser.toJSON()` — including the bcrypt password hash — into the
// JSON response. Only the register path stripped it.

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const PASSWORD = 'Rahasia123!'

let store = null
const createdIds = []

async function createLoginUser(overrides = {}) {
  const user = await db.user.create({
    userName: unique('d8user'),
    email: `${unique('d8mail')}@test.com`,
    password: PASSWORD,
    roleType: 'user',
    userType: 'user',
    store: store.id,
    status: 'active',
    ...overrides
  })
  createdIds.push(user.id)
  return user
}

async function expectSanitizedLogin(userName) {
  const res = await request(app).post('/auth/login').send({
    userName,
    password: PASSWORD
  })

  // 1. authentication still succeeds with the documented contract
  expect(res.status).toBe(200)
  expect(res.body?.token).toBeTruthy()
  expect(res.body?.user?.userName).toBe(userName.toLowerCase())

  // 2. no credential verifier anywhere in the HTTP response
  expect(res.body?.user).not.toHaveProperty('password')
  // the hash is excluded from default reads (P0-1); read it explicitly
  const stored = await db.user.scope('withCredentials').findOne({
    where: { userName: userName.toLowerCase() },
    paranoid: false
  })
  expect(stored.password).toBeTruthy() // hash really is stored…
  expect(JSON.stringify(res.body)).not.toContain(stored.password) // …but never returned

  // 3. legitimate non-sensitive contract fields remain
  expect(res.body?.user?.roleType).toBeTruthy()
  expect(res.body?.user?.id).toBeTruthy()
  return res
}

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({
    name: `D8_STORE_${Date.now()}`,
    status: 'active'
  }))
})

afterAll(async () => {
  await db.user.destroy({ where: { id: createdIds }, force: true })
  if (store) {
    await db.location.destroy({ where: { id: store.id }, force: true })
  }
})

describe('D8 login response password-hash disclosure', () => {
  test('D8-A admin/user branch (auth.js:422) omits password hash', async () => {
    const user = await createLoginUser({ userType: 'user' })
    await expectSanitizedLogin(user.userName)
  })

  test('D8-B non-admin/user branch (auth.js:404) omits password hash', async () => {
    const user = await createLoginUser({
      userType: 'super_admin',
      roleType: 'super_admin',
      store: null
    })
    await expectSanitizedLogin(user.userName)
  })
})
