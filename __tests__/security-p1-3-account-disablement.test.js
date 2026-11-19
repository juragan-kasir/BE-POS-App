process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const jwt = require('jsonwebtoken')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const PREFIX = `p13_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const sign = (claims) => signSessionToken(claims, JWT_SECRET)
const bearer = (token) => ({ Authorization: `Bearer ${token}` })
const PASSWORD = 'Rahasia123!'

let storeA = null
const createdUserIds = []
let adminA = null

const makeUser = async (key, attrs) => {
  const name = unique(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: PASSWORD,
    fullName: name,
    userType: 'user',
    roleType: 'user',
    status: 'active',
    store: storeA.id,
    ...attrs
  })
  createdUserIds.push(row.id)
  return row
}

const snapshotAuth = async (id) => {
  const row = await db.user.findByPk(id, { paranoid: false })
  const plain = row.get({ plain: true })
  return { status: plain.status, disabledAt: plain.disabledAt || null, updatedAt: plain.updatedAt }
}

const sessionCountFor = (userId) =>
  db.authorizationContextSession
    ? db.authorizationContextSession.count({ where: { userId } })
    : Promise.resolve(0)

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: unique('STORE_A'), status: 'active' }))
  adminA = await makeUser('adminA', { roleType: 'admin', userType: 'admin' })
})

afterAll(async () => {
  const rows = await db.user.findAll({ where: { id: createdUserIds }, attributes: ['id'], paranoid: false })
  const ids = rows.map((r) => r.id)
  if (ids.length) {
    await db.authorizationContextSession.destroy({ where: { userId: ids }, force: true }).catch(() => {})
    await db.user.destroy({ where: { id: ids }, force: true }).catch(() => {})
  }
  await db.location.destroy({ where: { id: [storeA?.id].filter(Boolean) }, force: true }).catch(() => {})
})

const adminToken = () => sign({ id: adminA.id, roleType: 'admin', store: storeA.id })

// ---- enabled login preserves behavior ----
describe('P1-3 enabled login', () => {
  test('enabled + valid credentials → 200, token issued, presence active', async () => {
    const u = await makeUser('enOk', {})
    const res = await request(app).post('/auth/login').send({ userName: u.userName, password: PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeDefined()
    expect((await db.user.findByPk(u.id)).status).toBe('active')
  })

  test('invalid credentials preserve existing behavior', async () => {
    const u = await makeUser('enBad', {})
    const res = await request(app).post('/auth/login').send({ userName: u.userName, password: 'Salah123!!' })
    expect(res.status).toBe(401)
  })

  test('soft-deleted denial preserved', async () => {
    const u = await makeUser('enDel', {})
    await db.user.destroy({ where: { id: u.id } })
    const res = await request(app).post('/auth/login').send({ userName: u.userName, password: PASSWORD })
    expect(res.status).toBe(401)
  })
})

// ---- disabled login denied ----
describe('P1-3 disabled login denied', () => {
  test('disabled + valid credentials → 401 generic shape, no token/session/mutation', async () => {
    const u = await makeUser('dis1', {})
    await db.user.update({ disabledAt: new Date() }, { where: { id: u.id } })
    const before = await snapshotAuth(u.id)
    const sessionsBefore = await sessionCountFor(u.id)
    const res = await request(app).post('/auth/login').send({ userName: u.userName, password: PASSWORD })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ message: 'User Name / Email Tidak Ditemukan' })
    expect(res.body.token).toBeUndefined()
    expect(await sessionCountFor(u.id)).toBe(sessionsBefore)
    const after = await snapshotAuth(u.id)
    expect(after.status).toBe(before.status)
    expect(new Date(after.disabledAt).getTime()).toBe(new Date(before.disabledAt).getTime())
    expect(after.updatedAt).toEqual(before.updatedAt)
  })

  test('disabled + invalid credentials → 401 (existing contract preserved)', async () => {
    const u = await makeUser('dis2', {})
    await db.user.update({ disabledAt: new Date() }, { where: { id: u.id } })
    const res = await request(app).post('/auth/login').send({ userName: u.userName, password: 'Salah123!!' })
    expect(res.status).toBe(401)
  })
})

// ---- admin lifecycle ----
describe('P1-3 admin disable/re-enable lifecycle', () => {
  test('disable → disabledAt set + inactive; login denied; re-enable → NULL + login works', async () => {
    const u = await makeUser('life1', {})
    const t = await adminToken()
    let res = await request(app).put('/auth/change-user-status').set(bearer(t)).send({ id: u.id, status: 'inactive' })
    expect(res.status).toBe(200)
    let row = await db.user.findByPk(u.id)
    expect(row.disabledAt).not.toBeNull()
    expect(row.status).toBe('inactive')

    res = await request(app).post('/auth/login').send({ userName: u.userName, password: PASSWORD })
    expect(res.status).toBe(401)
    expect(res.body.token).toBeUndefined()

    res = await request(app).put('/auth/change-user-status').set(bearer(t)).send({ id: u.id, status: 'active' })
    expect(res.status).toBe(200)
    row = await db.user.findByPk(u.id)
    expect(row.disabledAt).toBeNull()
    expect(row.status).toBe('active')

    res = await request(app).post('/auth/login').send({ userName: u.userName, password: PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeDefined()
  })
})

// ---- logout compatibility ----
describe('P1-3 logout compatibility', () => {
  test('logout never disables the account; next login succeeds + restores active', async () => {
    const u = await makeUser('loLeg', {})
    const tok = await sign({ id: u.id, roleType: 'user', store: storeA.id })
    let res = await request(app).post('/auth/logout').set(bearer(tok))
    expect(res.status).toBe(200)
    const row = await db.user.findByPk(u.id)
    expect(row.disabledAt).toBeNull()

    res = await request(app).post('/auth/login').send({ userName: u.userName, password: PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeDefined()
    expect((await db.user.findByPk(u.id)).status).toBe('active')
  })

  test('AUTH-1 P2: a sessionless token can no longer reach logout (401)', async () => {
    const u = await makeUser('loNoSession', {})
    const sessionless = jwt.sign({ id: u.id, roleType: 'user', store: storeA.id }, JWT_SECRET)
    const res = await request(app).post('/auth/logout').set(bearer(sessionless))
    expect(res.status).toBe(401)
    expect((await db.user.findByPk(u.id)).disabledAt).toBeNull()
  })
})
