process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// AUTH-1 P1 — login/session foundation. Every login credential is bound to
// an authorization session created in one transaction with a locked re-check
// of the account; the JWT and the session share one configured lifetime;
// session failure fails closed; /auth/edit-user mints no credential.

const request = require('supertest')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcrypt')
const timespan = require('jsonwebtoken/lib/timespan')
const app = require('../api/index')
const db = require('../db/models')

const PREFIX = `p1ls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const bearer = (token) => ({ Authorization: `Bearer ${token}` })
const PASSWORD = 'Rahasia123!'

let storeA = null
const createdUserIds = []

const makeUser = async (key, attrs = {}) => {
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

const login = (user, { password = PASSWORD, rememberMe } = {}) =>
  request(app)
    .post('/auth/login')
    .send({
      userName: user.userName,
      password,
      ...(rememberMe === undefined ? {} : { rememberMe })
    })

const sessionCountFor = (userId) => db.authorizationContextSession.count({ where: { userId } })
const presenceOf = async (id) => (await db.user.findByPk(id, { paranoid: false })).status

// Runs `between` after the real password verification and before the
// login's transactional re-check — a deterministic stand-in for a
// concurrent admin/user action landing in that window.
const interleaveAfterPasswordCheck = (between) => {
  const realCompare = bcrypt.compare
  return jest.spyOn(bcrypt, 'compare').mockImplementationOnce(async (...args) => {
    const ok = await realCompare.apply(bcrypt, args)
    await between()
    return ok
  })
}

beforeAll(async () => {
  storeA = await db.location.create({ name: unique('STORE_A'), status: 'active' })
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

describe('P1 login creates a session-bound credential', () => {
  test('login succeeds, persists a session for the user, and the JWT carries its sessionId', async () => {
    const u = await makeUser('ok', { roleType: 'admin', userType: 'admin' })

    const res = await login(u)

    expect(res.status).toBe(200)
    expect(res.body.message).toBe('Success Login')
    expect(res.body.user.password).toBeUndefined()
    const claims = jwt.verify(res.body.token, process.env.JWT_SECRET_KEY)
    expect(claims.id).toBe(u.id)
    expect(claims.sessionId).toMatch(/^[0-9a-f]{64}$/)
    expect(Number.isInteger(claims.iat)).toBe(true)
    expect(Number.isInteger(claims.exp)).toBe(true)
    // P6: minimized claims — only canonical identity/session identifiers.
    expect([...Object.keys(claims)].sort()).toEqual(['exp', 'iat', 'id', 'sessionId'])

    const session = await db.authorizationContextSession.findOne({ where: { sessionId: claims.sessionId } })
    expect(session).not.toBeNull()
    expect(session.userId).toBe(u.id)
    expect(session.revokedAt).toBeNull()
  })

  test('concurrent logins for the same account each get their own session', async () => {
    const u = await makeUser('parallel')

    const [a, b] = await Promise.all([login(u), login(u)])

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const sa = jwt.decode(a.body.token).sessionId
    const sb = jwt.decode(b.body.token).sessionId
    expect(sa).not.toBe(sb)
    expect(await sessionCountFor(u.id)).toBe(2)
  })
})

describe('P1 single authentication lifetime', () => {
  const expectedLifetime = (iat) => timespan(process.env.JWT_EXPIRED_IN || '1d', iat) - iat

  test('session expiresAt equals the JWT exp, derived from the configured lifetime', async () => {
    const u = await makeUser('life')

    const res = await login(u)

    const claims = jwt.decode(res.body.token)
    expect(claims.exp - claims.iat).toBe(expectedLifetime(claims.iat))
    const session = await db.authorizationContextSession.findOne({ where: { sessionId: claims.sessionId } })
    expect(new Date(session.expiresAt).getTime()).toBe(claims.exp * 1000)
  })

  test('changing JWT_EXPIRED_IN moves both the JWT and the session lifetime', async () => {
    const u = await makeUser('life2h')
    const previous = process.env.JWT_EXPIRED_IN
    process.env.JWT_EXPIRED_IN = '2h'
    try {
      const res = await login(u)

      const claims = jwt.decode(res.body.token)
      expect(claims.exp - claims.iat).toBe(2 * 60 * 60)
      const session = await db.authorizationContextSession.findOne({ where: { sessionId: claims.sessionId } })
      expect(new Date(session.expiresAt).getTime()).toBe(claims.exp * 1000)
    } finally {
      if (previous === undefined) delete process.env.JWT_EXPIRED_IN
      else process.env.JWT_EXPIRED_IN = previous
    }
  })
})

describe('P1 remember-me lifetime', () => {
  const defaultLifetime = (iat) =>
    timespan(process.env.JWT_EXPIRED_IN || '1d', iat) - iat
  const rememberLifetime = (iat) =>
    timespan(process.env.JWT_REMEMBER_ME_EXPIRED_IN || '30d', iat) - iat

  test('rememberMe extends the JWT and session lifetime', async () => {
    const u = await makeUser('remember')

    const res = await login(u, { rememberMe: true })

    expect(res.status).toBe(200)
    const claims = jwt.decode(res.body.token)
    expect(claims.exp - claims.iat).toBe(rememberLifetime(claims.iat))
    const session = await db.authorizationContextSession.findOne({
      where: { sessionId: claims.sessionId }
    })
    expect(new Date(session.expiresAt).getTime()).toBe(claims.exp * 1000)
  })

  test('rememberMe false keeps the default authentication lifetime', async () => {
    const u = await makeUser('no-remember')

    const res = await login(u, { rememberMe: false })

    expect(res.status).toBe(200)
    const claims = jwt.decode(res.body.token)
    expect(claims.exp - claims.iat).toBe(defaultLifetime(claims.iat))
  })

  test('JWT_REMEMBER_ME_EXPIRED_IN overrides the remember-me lifetime', async () => {
    const u = await makeUser('remember-env')
    const previous = process.env.JWT_REMEMBER_ME_EXPIRED_IN
    process.env.JWT_REMEMBER_ME_EXPIRED_IN = '7d'
    try {
      const res = await login(u, { rememberMe: true })

      expect(res.status).toBe(200)
      const claims = jwt.decode(res.body.token)
      expect(claims.exp - claims.iat).toBe(7 * 24 * 60 * 60)
    } finally {
      if (previous === undefined) delete process.env.JWT_REMEMBER_ME_EXPIRED_IN
      else process.env.JWT_REMEMBER_ME_EXPIRED_IN = previous
    }
  })
})

describe('P1 fail-closed login', () => {
  test('session creation failure → 500, no token, no cookie, nothing committed', async () => {
    const u = await makeUser('boom', { status: 'inactive' })
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('P1_SESSION_INSERT_FAILED internal detail')
    jest.spyOn(db.authorizationContextSession, 'create').mockRejectedValueOnce(failure)

    const res = await login(u)

    expect(res.status).toBe(500)
    expect(res.body.token).toBeUndefined()
    expect(res.body.user).toBeUndefined()
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('P1_SESSION_INSERT_FAILED')
    expect(await sessionCountFor(u.id)).toBe(0)
    // The presence write shares the rolled-back transaction.
    expect(await presenceOf(u.id)).toBe('inactive')
    // Not swallowed: surfaced through the existing login error log.
    expect(logged).toHaveBeenCalledWith('ERROR LOGIN =>', failure)
  })

  test('JWT signing failure after the session committed still returns no credential', async () => {
    const u = await makeUser('signfail')
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(jwt, 'sign').mockImplementationOnce(() => {
      throw new Error('P1_SIGN_FAILED')
    })

    const res = await login(u)

    expect(res.status).toBe(500)
    expect(res.body.token).toBeUndefined()
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('P1_SIGN_FAILED')
  })
})

describe('P1 transactional re-check before credential issuance', () => {
  test('account disabled after password verification gets no session and no JWT', async () => {
    const u = await makeUser('raceDisable', { status: 'inactive' })
    interleaveAfterPasswordCheck(() => db.user.update({ disabledAt: new Date() }, { where: { id: u.id } }))

    const res = await login(u)

    expect(res.status).toBe(401)
    expect(res.body.message).toBe('User Name / Email Tidak Ditemukan')
    expect(res.body.token).toBeUndefined()
    expect(await sessionCountFor(u.id)).toBe(0)
    expect(await presenceOf(u.id)).toBe('inactive')
  })

  test('account soft-deleted after password verification gets no session and no JWT', async () => {
    const u = await makeUser('raceDelete')
    interleaveAfterPasswordCheck(() => db.user.destroy({ where: { id: u.id } }))

    const res = await login(u)

    expect(res.status).toBe(401)
    expect(res.body.token).toBeUndefined()
    expect(await sessionCountFor(u.id)).toBe(0)
  })

  test('password changed after verification → old password gets no session and no JWT', async () => {
    const u = await makeUser('raceHash')
    interleaveAfterPasswordCheck(() =>
      db.user.update({ password: 'Berbeda456!' }, { where: { id: u.id }, individualHooks: true })
    )

    const res = await login(u)

    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Password Salah')
    expect(res.body.token).toBeUndefined()
    expect(await sessionCountFor(u.id)).toBe(0)
  })
})

describe('P1 /auth/edit-user mints no credential', () => {
  test('profile update succeeds, returns no token, and the login session stays the credential', async () => {
    const u = await makeUser('edit')
    const loginRes = await login(u)
    const token = loginRes.body.token
    const sessionsBefore = await sessionCountFor(u.id)
    const signSpy = jest.spyOn(jwt, 'sign')

    const res = await request(app)
      .put('/auth/edit-user')
      .set(bearer(token))
      .send({ email: u.email, userName: u.userName, fullName: 'Nama Baru P1' })

    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('token')
    expect(res.body.user.fullName).toBe('Nama Baru P1')
    expect(res.body.user.password).toBeUndefined()
    expect(signSpy).not.toHaveBeenCalled()
    expect((await db.user.findByPk(u.id)).fullName).toBe('Nama Baru P1')
    expect(await sessionCountFor(u.id)).toBe(sessionsBefore)

    // The pre-edit credential is still the valid session-backed credential.
    const ctx = await request(app).get('/auth/context').set(bearer(token))
    expect(ctx.status).toBe(200)
  })
})
