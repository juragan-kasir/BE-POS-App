process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// FINDINGS.md E2E-03: login lowercased the submitted identifier but the
// stored userName kept its original case, so any account created with an
// uppercase letter could never log in. These tests pin both halves of the
// fix: new rows are normalized on save, and the login lookup is
// case-insensitive so rows written before the fix are not locked out.

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

const PASSWORD = 'Rahasia123!'
const PREFIX = `uname_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`
const emailFor = (key) => `${unique(key)}@test.com`

let location = null
const createdUserIds = []

const createUser = async (userName, key) =>
  db.user.create({
    userName,
    email: emailFor(key),
    password: PASSWORD,
    fullName: key,
    userType: 'user',
    roleType: 'user',
    status: 'active',
    store: location.id
  })

const login = (userName) =>
  request(app).post('/auth/login').send({ userName, password: PASSWORD })

beforeAll(async () => {
  location = await db.location.create({
    name: `UNAME_CASE_${PREFIX}`,
    status: 'active'
  })
})

afterAll(async () => {
  if (createdUserIds.length) {
    await db.authorizationContextSession
      .destroy({ where: { userId: createdUserIds }, force: true })
      .catch(() => {})
    await db.user.destroy({ where: { id: createdUserIds }, force: true })
  }
  if (location) await db.location.destroy({ where: { id: location.id }, force: true })
})

test('a mixed-case username created through the model can log in', async () => {
  const userName = `Owner_${PREFIX}_A`
  const user = await createUser(userName, 'a')
  createdUserIds.push(user.id)

  expect(user.userName).toBe(userName.toLowerCase())

  const res = await login(userName)
  expect(res.status).toBe(200)
  expect(res.body.token).toBeTruthy()
})

test('a legacy mixed-case row (written before normalization) can log in', async () => {
  const userName = `Legacy_${PREFIX}_B`
  const user = await createUser(userName.toLowerCase(), 'b')
  createdUserIds.push(user.id)

  await db.sequelize.query(
    'UPDATE "user" SET "userName" = :userName WHERE id = :id',
    { replacements: { userName, id: user.id } }
  )

  const res = await login(userName)
  expect(res.status).toBe(200)
  expect(res.body.token).toBeTruthy()
})
