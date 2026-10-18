process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

// DR-24 C-24a / DR-20 §35.6: authentication events are mandatory audit
// entries. Every login outcome (success, wrong password, unknown account,
// deleted/disabled account) and every logout must leave a record in the
// append-only audit log with a safe reason code and no credential material.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const PASSWORD = 'Rahasia123!'
const createdIds = []
let store

const createLoginUser = async (overrides = {}) => {
  const user = await db.user.create({
    userName: unique('auditlogin'),
    email: `${unique('auditmail')}@test.com`,
    password: PASSWORD,
    userType: 'user',
    status: 'active',
    store: store.id,
    ...overrides
  })
  createdIds.push(user.id)
  return user
}

const login = (userName, password = PASSWORD) =>
  request(app).post('/auth/login').send({ userName, password })

const findAuthRow = async (action, match) => {
  const rows = await db.auditLog.findAll({
    where: { action, entity: 'AUTH' },
    order: [['id', 'DESC']]
  })
  return rows.find(match)
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('C24A_STORE'), status: 'active' })
})

afterAll(async () => {
  await db.authorizationContextSession.destroy({ where: { userId: createdIds } })
  await db.auditLog.destroy({
    where: { entity: 'AUTH', userId: createdIds },
    force: true,
    __auditMaintenance: true
  })
  await db.user.destroy({ where: { id: createdIds }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

test('a successful login is audited with SUCCESS and identity context', async () => {
  const user = await createLoginUser()
  const res = await login(user.userName)
  expect(res.status).toBe(200)

  const row = await findAuthRow('login', (r) => r.userId === user.id)
  expect(row).toBeTruthy()
  expect(row.result).toBe('SUCCESS')
  expect(row.actorType).toBe('USER')
  expect(row.userName).toBe(user.userName)
  expect(row.entityId).toBe(user.id)
  expect(row.store).toBe(store.id)
  expect(row.source).toBe('password')
  expect(row.metadata?.roleType).toBe('user')
  expect(row.metadata?.userType).toBe('user')
  expect(row.reason).toBeNull()
  expect(row.oldValues).toBeNull()
  expect(row.newValues).toBeNull()

  // DR-20: no credential material may ever land in the row.
  const serialized = JSON.stringify(row.toJSON())
  expect(serialized).not.toContain(PASSWORD)
  expect(serialized).not.toContain(res.body.token)
})

test('a wrong password is audited as FAILURE with a safe reason code', async () => {
  const user = await createLoginUser()
  const res = await login(user.userName, 'WrongPassword!9')
  expect(res.status).toBe(401)

  const row = await findAuthRow('login', (r) => r.userId === user.id)
  expect(row).toBeTruthy()
  expect(row.result).toBe('FAILURE')
  expect(row.reason).toBe('INVALID_PASSWORD')
  expect(JSON.stringify(row.toJSON())).not.toContain('WrongPassword!9')
})

test('an unknown identity is audited as DENIED attributed to the attempt', async () => {
  const attempted = unique('ghost')
  const res = await login(attempted)
  expect(res.status).toBe(401)

  const row = await findAuthRow('login', (r) => r.userName === attempted)
  expect(row).toBeTruthy()
  expect(row.result).toBe('DENIED')
  expect(row.reason).toBe('USER_NOT_FOUND')
  expect(row.userId).toBeNull()
  expect(row.entity).toBe('AUTH')
})

test('a disabled account is audited as DENIED without minting a session', async () => {
  const user = await createLoginUser({ disabledAt: new Date() })
  const res = await login(user.userName)
  expect(res.status).toBe(401)

  const row = await findAuthRow('login', (r) => r.userId === user.id)
  expect(row).toBeTruthy()
  expect(row.result).toBe('DENIED')
  expect(row.reason).toBe('ACCOUNT_DISABLED')

  const sessions = await db.authorizationContextSession.count({
    where: { userId: user.id }
  })
  expect(sessions).toBe(0)
})

test('a soft-deleted account is audited as DENIED', async () => {
  const user = await createLoginUser()
  await db.user.destroy({ where: { id: user.id } })

  const res = await login(user.userName)
  expect(res.status).toBe(401)

  const row = await findAuthRow('login', (r) => r.userId === user.id)
  expect(row).toBeTruthy()
  expect(row.result).toBe('DENIED')
  expect(row.reason).toBe('ACCOUNT_DELETED')

  await db.user.destroy({ where: { id: user.id }, force: true })
})

test('a successful logout is audited as SUCCESS for the revoked session actor', async () => {
  const user = await createLoginUser()
  const loginRes = await login(user.userName)
  expect(loginRes.status).toBe(200)

  const res = await request(app)
    .post('/auth/logout')
    .set('Authorization', `Bearer ${loginRes.body.token}`)
  expect(res.status).toBe(200)

  const row = await findAuthRow('logout', (r) => r.userId === user.id)
  expect(row).toBeTruthy()
  expect(row.result).toBe('SUCCESS')
  expect(row.actorType).toBe('USER')
  expect(row.entityId).toBe(user.id)
  expect(JSON.stringify(row.toJSON())).not.toContain(loginRes.body.token)
})
