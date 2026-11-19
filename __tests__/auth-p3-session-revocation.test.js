process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// AUTH-1 P3 — session revocation. A session is valid only while its DB row is
// live; logout, disable, soft-delete and credential changes revoke sessions,
// and revocation (`revokedAt`) is write-once: nothing ever makes a revoked
// session valid again (DR-03 Q8).

const request = require('supertest')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const mw = require('../utils/authorizationContextMiddleware')
const { hashResetToken } = require('../utils/resetToken')
const { signSessionToken, createAuthenticatedTestSession } = require('../test-helpers/authSession')

const SECRET = process.env.JWT_SECRET_KEY
const PASSWORD = 'Rahasia123!'
const PREFIX = `p3rv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const bearer = (token) => ({ Authorization: `Bearer ${token}` })

let storeA = null
let admin = null
let adminToken = null
const createdUserIds = []

const makeUser = async (key, attrs = {}) => {
  const name = unique(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: PASSWORD,
    fullName: name,
    userType: 'user',
    roleType: 'kasir',
    status: 'active',
    store: storeA.id,
    ...attrs
  })
  createdUserIds.push(row.id)
  return row
}

const login = async (user, password = PASSWORD) => {
  const res = await request(app).post('/auth/login').send({ userName: user.userName, password })
  return { res, token: res.body.token, sessionId: res.body.token ? jwt.decode(res.body.token).sessionId : null }
}

// A real session for a user (login itself is exercised only where it is
// the subject; /auth/login is rate-limited per IP).
const mint = async (user) => {
  const token = await signSessionToken({ id: user.id }, SECRET)
  return { token, sessionId: jwt.decode(token).sessionId }
}

// Any authenticated route runs the canonical session check; /auth/context
// answers 200 for every valid caller.
const probe = async (token) => (await request(app).get('/auth/context').set(bearer(token))).status
const sessionRow = (sessionId) => db.authorizationContextSession.findOne({ where: { sessionId } })
const liveSessionsOf = (userId) => db.authorizationContextSession.count({ where: { userId, revokedAt: null } })

const disable = (userId, status = 'inactive') =>
  request(app).put('/auth/change-user-status').set(bearer(adminToken)).send({ id: userId, status })

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: unique('STORE_A'), status: 'active' }))
  admin = await makeUser('admin', { roleType: 'admin', userType: 'admin' })
  adminToken = (await mint(admin)).token
})

afterEach(() => {
  jest.restoreAllMocks()
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

describe('P3 write-once revocation primitives', () => {
  test('repeated revocation keeps the original revokedAt', async () => {
    const u = await makeUser('writeOnce')
    const { sessionId } = await mint(u)

    expect(await mw.revokeContextSession(db, sessionId, u.id)).toBe(true)
    const first = (await sessionRow(sessionId)).revokedAt
    expect(first).not.toBeNull()

    await new Promise((r) => setTimeout(r, 20))
    expect(await mw.revokeContextSession(db, sessionId, u.id)).toBe(true)
    await mw.revokeAllUserSessions(db, u.id)
    expect((await sessionRow(sessionId)).revokedAt.getTime()).toBe(first.getTime())
  })

  test('concurrent revocations of one session leave exactly one timestamp', async () => {
    const u = await makeUser('concurrentRevoke')
    const { sessionId } = await mint(u)
    await Promise.all([
      mw.revokeContextSession(db, sessionId, u.id),
      mw.revokeContextSession(db, sessionId, u.id),
      mw.revokeAllUserSessions(db, u.id)
    ])
    const stamped = (await sessionRow(sessionId)).revokedAt
    expect(stamped).not.toBeNull()
    await mw.revokeAllUserSessions(db, u.id)
    expect((await sessionRow(sessionId)).revokedAt.getTime()).toBe(stamped.getTime())
  })

  test("revokeContextSession never touches another user's session", async () => {
    const owner = await makeUser('owner')
    const other = await makeUser('other')
    const { sessionId } = await mint(owner)
    expect(await mw.revokeContextSession(db, sessionId, other.id)).toBe(false)
    expect((await sessionRow(sessionId)).revokedAt).toBeNull()
  })

  test('revokeAllUserSessions revokes only the target user and is idempotent', async () => {
    const target = await makeUser('revokeAllTarget')
    const bystander = await makeUser('revokeAllBystander')
    const a = await mint(target)
    const b = await mint(target)
    const c = await mint(bystander)

    expect(await mw.revokeAllUserSessions(db, target.id)).toBe(2)
    expect(await mw.revokeAllUserSessions(db, target.id)).toBe(0)
    expect(await probe(a.token)).toBe(401)
    expect(await probe(b.token)).toBe(401)
    expect(await probe(c.token)).toBe(200)
  })

  test('an expired session stays distinct from a revoked one', async () => {
    const { user, session, token } = await createAuthenticatedTestSession(
      { userName: unique('expired'), password: PASSWORD, roleType: 'kasir', store: storeA.id },
      { ttlMs: -1000 }
    )
    createdUserIds.push(user.id)
    expect(await probe(token)).toBe(401)
    expect((await sessionRow(session.sessionId)).revokedAt).toBeNull()
  })
})

describe('P3 logout', () => {
  test('logout revokes only the current session; the same JWT is then 401', async () => {
    const u = await makeUser('logout')
    const current = await mint(u)
    const otherDevice = await mint(u)

    const res = await request(app).post('/auth/logout').set(bearer(current.token))
    expect(res.status).toBe(200)
    expect(res.body.message).toBe('User Berhasil Logout')

    const row = await sessionRow(current.sessionId)
    expect(row.revokedAt).not.toBeNull()
    expect(row.userId).toBe(u.id)
    expect(await probe(current.token)).toBe(401)
    expect(await probe(otherDevice.token)).toBe(200)
    // A repeat logout with the revoked credential cannot reach the handler.
    expect((await request(app).post('/auth/logout').set(bearer(current.token))).status).toBe(401)
  })

  test('logout does not change session expiry', async () => {
    const u = await makeUser('logoutExpiry')
    const { token, sessionId } = await mint(u)
    const before = (await sessionRow(sessionId)).expiresAt.getTime()
    await request(app).post('/auth/logout').set(bearer(token))
    expect((await sessionRow(sessionId)).expiresAt.getTime()).toBe(before)
  })

  test('a sessionless token cannot perform logout or touch any session', async () => {
    const u = await makeUser('logoutSessionless')
    const live = await mint(u)
    const sessionless = jwt.sign({ id: u.id, roleType: 'kasir', store: storeA.id }, SECRET)

    expect((await request(app).post('/auth/logout').set(bearer(sessionless))).status).toBe(401)
    expect(await liveSessionsOf(u.id)).toBe(1)
    expect(await probe(live.token)).toBe(200)
  })
})

describe('P3 disable', () => {
  test('disabling revokes every active session of that user only', async () => {
    const u = await makeUser('disable')
    const bystander = await makeUser('disableBystander')
    const s1 = await mint(u)
    const s2 = await mint(u)
    const preRevoked = await mint(u)
    await mw.revokeContextSession(db, preRevoked.sessionId, u.id)
    const preRevokedAt = (await sessionRow(preRevoked.sessionId)).revokedAt.getTime()
    const other = await mint(bystander)

    expect((await disable(u.id)).status).toBe(200)

    expect(await liveSessionsOf(u.id)).toBe(0)
    expect(await probe(s1.token)).toBe(401)
    expect(await probe(s2.token)).toBe(401)
    expect((await sessionRow(preRevoked.sessionId)).revokedAt.getTime()).toBe(preRevokedAt)
    expect(await probe(other.token)).toBe(200)
    expect(await probe(adminToken)).toBe(200)
  })

  test('re-enabling does not revive old sessions (DR-03 Q8); a fresh login works', async () => {
    const u = await makeUser('reenable')
    const old = await mint(u)
    await disable(u.id)
    expect((await disable(u.id, 'active')).status).toBe(200)

    expect(await probe(old.token)).toBe(401)
    expect((await sessionRow(old.sessionId)).revokedAt).not.toBeNull()
    const fresh = await login(u)
    expect(fresh.res.status).toBe(200)
    expect(fresh.sessionId).not.toBe(old.sessionId)
    expect(await probe(fresh.token)).toBe(200)
  })

  test('disable and revocation are atomic: a revocation failure leaves the account enabled', async () => {
    const u = await makeUser('disableAtomic')
    const s = await mint(u)
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(db.authorizationContextSession, 'update').mockRejectedValueOnce(new Error('revoke failed'))

    expect((await disable(u.id)).status).toBe(500)

    expect((await db.user.findByPk(u.id)).disabledAt).toBeNull()
    expect(await probe(s.token)).toBe(200)
  })
})

describe('P3 soft-delete', () => {
  test('soft-delete revokes sessions; a restored account does not revive them; a new login works', async () => {
    const u = await makeUser('softDelete')
    const old = await mint(u)

    const res = await request(app).delete(`/employee/delete-employee/${u.id}`).set(bearer(adminToken))
    expect(res.status).toBe(200)
    expect(await liveSessionsOf(u.id)).toBe(0)
    expect(await probe(old.token)).toBe(401)

    // No restore API exists; restore at the model level.
    await db.user.restore({ where: { id: u.id } })
    expect(await probe(old.token)).toBe(401)

    const fresh = await login(u)
    expect(fresh.res.status).toBe(200)
    expect(await probe(fresh.token)).toBe(200)
  })
})

describe('P3 credential changes', () => {
  test('password reset revokes every session; old JWT 401; new password logs in', async () => {
    const u = await makeUser('reset')
    const s1 = await mint(u)
    const s2 = await mint(u)
    const resetToken = crypto.randomBytes(16).toString('hex')
    await db.user.update(
      { resetToken: hashResetToken(resetToken), resetTokenExpires: new Date(Date.now() + 10 * 60 * 1000) },
      { where: { id: u.id } }
    )

    const res = await request(app)
      .post('/auth/reset-password')
      .send({ email: u.email, token: resetToken, newPassword: 'BaruSekali1!', confirmPassword: 'BaruSekali1!' })
    expect(res.status).toBe(200)

    expect(await probe(s1.token)).toBe(401)
    expect(await probe(s2.token)).toBe(401)
    expect((await login(u)).res.status).toBe(401)
    const fresh = await login(u, 'BaruSekali1!')
    expect(fresh.res.status).toBe(200)
    expect(await probe(fresh.token)).toBe(200)
  })

  test("admin changing an employee's password revokes the employee's sessions, not the admin's", async () => {
    const u = await makeUser('adminPw')
    const s = await mint(u)

    const res = await request(app)
      .put('/employee/edit-employee')
      .set(bearer(adminToken))
      .send({ id: u.id, password: 'GantiAdmin1!', confirmPassword: 'GantiAdmin1!' })
    expect(res.status).toBe(200)

    expect(await probe(s.token)).toBe(401)
    expect(await probe(adminToken)).toBe(200)
    expect((await login(u, 'GantiAdmin1!')).res.status).toBe(200)
  })

  test('an employee edit without a password change revokes nothing', async () => {
    const u = await makeUser('adminEditNoPw')
    const s = await mint(u)
    const res = await request(app)
      .put('/employee/edit-employee')
      .set(bearer(adminToken))
      .send({ id: u.id, fullName: 'Nama Baru P3' })
    expect(res.status).toBe(200)
    expect(await probe(s.token)).toBe(200)
  })

  test('password change and revocation are atomic: a revocation failure keeps the old password', async () => {
    const u = await makeUser('pwAtomic')
    const s = await mint(u)
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(db.authorizationContextSession, 'update').mockRejectedValueOnce(new Error('revoke failed'))

    const res = await request(app)
      .put('/employee/edit-employee')
      .set(bearer(adminToken))
      .send({ id: u.id, password: 'TidakJadi1!', confirmPassword: 'TidakJadi1!' })
    expect(res.status).toBe(500)

    jest.restoreAllMocks()
    expect(await probe(s.token)).toBe(200)
    expect((await login(u)).res.status).toBe(200)
  })
})

describe('P3 concurrency', () => {
  test('login racing a disable never leaves a usable session for the disabled account', async () => {
    for (let i = 0; i < 4; i++) {
      const u = await makeUser(`raceDisable${i}`)
      const [loginOut, disableRes] = await Promise.all([login(u), disable(u.id)])
      expect(disableRes.status).toBe(200)
      expect(await liveSessionsOf(u.id)).toBe(0)
      if (loginOut.token) expect(await probe(loginOut.token)).toBe(401)
    }
  })

  test('login with the old password racing a password change never leaves a usable stale session', async () => {
    for (let i = 0; i < 4; i++) {
      const u = await makeUser(`racePw${i}`)
      const [loginOut, changeRes] = await Promise.all([
        login(u),
        request(app)
          .put('/employee/edit-employee')
          .set(bearer(adminToken))
          .send({ id: u.id, password: `Ganti${i}Race!`, confirmPassword: `Ganti${i}Race!` })
      ])
      expect(changeRes.status).toBe(200)
      expect(await liveSessionsOf(u.id)).toBe(0)
      if (loginOut.token) expect(await probe(loginOut.token)).toBe(401)
    }
  })

  test('a disable landing between password check and issuance yields no credential (P1 re-check preserved)', async () => {
    const bcrypt = require('bcrypt')
    const u = await makeUser('interleave')
    const realCompare = bcrypt.compare
    jest.spyOn(bcrypt, 'compare').mockImplementationOnce(async (...args) => {
      const ok = await realCompare.apply(bcrypt, args)
      await disable(u.id)
      return ok
    })
    const out = await login(u)
    expect(out.res.status).toBe(401)
    expect(out.token).toBeUndefined()
    expect(await liveSessionsOf(u.id)).toBe(0)
  })
})

// Guard: the helper-minted fixtures used across the suite obey the same rules.
test('a helper-minted session is revoked by disable like any login session', async () => {
  const u = await makeUser('helperMinted')
  const token = await signSessionToken({ id: u.id }, SECRET)
  expect(await probe(token)).toBe(200)
  await disable(u.id)
  expect(await probe(token)).toBe(401)
})
