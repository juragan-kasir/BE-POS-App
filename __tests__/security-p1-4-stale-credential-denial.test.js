process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const jwt = require('jsonwebtoken')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const DENIED = 'Akses Ditolak - Anda tidak memiliki izin'
const PREFIX = `p14_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const sign = (claims) => signSessionToken(claims, JWT_SECRET)
const bearer = (token) => ({ Authorization: `Bearer ${token}` })
const PASSWORD = 'Rahasia123!'

let storeA = null
const createdUserIds = []
let caller = null
let empA = null

const snapshotAuth = async (id) => {
  const row = await db.user.findByPk(id, { paranoid: false })
  const plain = row.get({ plain: true })
  return { status: plain.status, disabledAt: plain.disabledAt || null, updatedAt: plain.updatedAt }
}

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: unique('STORE_A'), status: 'active' }))
  const mk = async (key, attrs) => {
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
  caller = await mk('caller', { roleType: 'admin', userType: 'admin' })
  empA = await mk('empA', { employeeID: `E${Date.now()}${++seq}` })
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

const callerToken = () => sign({ id: caller.id, roleType: 'admin', store: storeA.id })
const empPath = () => `/employee/get-employee/${empA.id}`

describe('P1-4 legacy stale credential denial', () => {
  test('enabled JWT control → 200', async () => {
    const res = await request(app).get(empPath()).set(bearer(await callerToken()))
    expect(res.status).toBe(200)
  })

  test('disable → same JWT 403 exact shape, no mutation', async () => {
    const tok = await callerToken()
    await db.user.update({ disabledAt: new Date() }, { where: { id: caller.id } })
    const before = await snapshotAuth(caller.id)
    const res = await request(app).get(empPath()).set(bearer(tok))
    expect(res.status).toBe(403)
    expect(res.body.message).toBe(DENIED)
    const after = await snapshotAuth(caller.id)
    expect(after.status).toBe(before.status)
    expect(new Date(after.disabledAt).getTime()).toBe(new Date(before.disabledAt).getTime())
    expect(after.updatedAt).toEqual(before.updatedAt)
    await db.user.update({ disabledAt: null }, { where: { id: caller.id } })
  })
})

// These P1-4 cases write `disabledAt` directly, bypassing the canonical
// disable operation (which also revokes every session — AUTH-1 P3, see
// auth-p3-session-revocation). They pin the per-request account gate as an
// independent defense: it denies even while a session row is still live.
describe('P1-4 session-backed stale credential denial', () => {
  test('login session works; direct disabledAt write → same token 403 via the account gate', async () => {
    const login = await request(app).post('/auth/login').send({ userName: caller.userName, password: PASSWORD })
    expect(login.status).toBe(200)
    const token = login.body.token
    expect(token).toBeDefined()
    let res = await request(app).get(empPath()).set(bearer(token))
    expect(res.status).toBe(200)

    await db.user.update({ disabledAt: new Date() }, { where: { id: caller.id } })
    const sessBefore = await db.authorizationContextSession.findAll({ where: { userId: caller.id } })
    res = await request(app).get(empPath()).set(bearer(token))
    expect(res.status).toBe(403)
    expect(res.body.message).toBe(DENIED)
    const sessAfter = await db.authorizationContextSession.findAll({ where: { userId: caller.id } })
    expect(sessAfter.length).toBe(sessBefore.length)
    for (const s of sessAfter) expect(s.revokedAt).toBeNull()
    await db.user.update({ disabledAt: null }, { where: { id: caller.id } })
  })
})

describe('P1-4 canonical route denial', () => {
  test('enabled /auth/context succeeds; disable → same credential 403, handler skipped', async () => {
    const login = await request(app).post('/auth/login').send({ userName: caller.userName, password: PASSWORD })
    const token = login.body.token
    let res = await request(app).get('/auth/context').set(bearer(token))
    expect(res.status).toBe(200)

    await db.user.update({ disabledAt: new Date() }, { where: { id: caller.id } })
    res = await request(app).get('/auth/context').set(bearer(token))
    expect(res.status).toBe(403)
    expect(res.body.message).toBe(DENIED)
    await db.user.update({ disabledAt: null }, { where: { id: caller.id } })
  })
})

describe('P1-4 account gate follows current state (direct DB writes)', () => {
  test('old JWT denied while disabled; fresh login after re-enable; a still-live session follows current state', async () => {
    const tok = await callerToken()
    await db.user.update({ disabledAt: new Date() }, { where: { id: caller.id } })
    expect((await request(app).get(empPath()).set(bearer(tok))).status).toBe(403)

    await db.user.update({ disabledAt: null }, { where: { id: caller.id } })
    const login = await request(app).post('/auth/login').send({ userName: caller.userName, password: PASSWORD })
    expect(login.status).toBe(200)
    expect(login.body.token).toBeDefined()
    // Only reachable because this test flips `disabledAt` directly and so
    // never revoked the session: a live session follows current account
    // state. The canonical disable operation revokes it, and a revoked
    // session stays dead after re-enable (DR-03 Q8, auth-p3 suite).
    expect((await request(app).get(empPath()).set(bearer(tok))).status).toBe(200)
  })
})

describe('P1-4 unknown/soft-deleted caller denial', () => {
  test('signed JWT for nonexistent user → 401 (AUTH-1 P2: no session can exist for it)', async () => {
    const tok = jwt.sign({ id: 2147480000, roleType: 'admin', store: storeA.id }, JWT_SECRET)
    const res = await request(app).get(empPath()).set(bearer(tok))
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('SESSION_INVALID')
  })

  test('signed JWT for soft-deleted user → 403 same shape', async () => {
    const name = unique('gone')
    const row = await db.user.create({
      userName: name,
      email: `${name}@test.com`,
      password: PASSWORD,
      fullName: name,
      userType: 'user',
      roleType: 'user',
      status: 'active',
      store: storeA.id
    })
    createdUserIds.push(row.id)
    const tok = await sign({ id: row.id, roleType: 'user', store: storeA.id })
    await db.user.destroy({ where: { id: row.id } })
    const res = await request(app).get(empPath()).set(bearer(tok))
    expect(res.status).toBe(403)
    expect(res.body.message).toBe(DENIED)
  })
})
