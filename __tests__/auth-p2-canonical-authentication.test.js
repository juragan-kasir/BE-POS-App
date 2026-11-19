process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// AUTH-1 P2 — canonical authentication + DB hydration. Every authenticated
// request must present a live DB session owned by the JWT's `id`; req.user is
// hydrated from the current account row, so mutable JWT claims (roleType,
// store, …) can neither grant nor keep authorization.

const request = require('supertest')
const jwt = require('jsonwebtoken')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const authorization = require('../utils/authorization')
const { requireRole } = require('../utils/authorization')
const { validateStoreAccess } = require('../utils/storeValidation')
const mw = require('../utils/authorizationContextMiddleware')
const { createAuthenticatedTestSession } = require('../test-helpers/authSession')

const SECRET = process.env.JWT_SECRET_KEY
const PREFIX = `p2ca_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const bearer = (token) => ({ Authorization: `Bearer ${token}` })

const ADMIN_ROUTE = '/best-selling/get-chart-by-year' // requireRole('super_admin', 'admin')
const storeRoute = (storeId) => `/tax-config?store=${storeId}` // validateStoreAccess

let storeA = null
let storeB = null
const createdUserIds = []

const userAttrs = (key, attrs = {}) => {
  const name = unique(key)
  return {
    userName: name,
    email: `${name}@test.com`,
    password: 'Rahasia123!',
    fullName: name,
    userType: 'user',
    roleType: 'kasir',
    status: 'active',
    store: storeA.id,
    ...attrs
  }
}

const authenticated = async (key, attrs, opts) => {
  const out = await createAuthenticatedTestSession(userAttrs(key, attrs), opts)
  createdUserIds.push(out.user.id)
  return out
}

// A token for an existing session whose claims say whatever the test wants.
const forge = (session, claims) => jwt.sign({ id: session.userId, sessionId: session.sessionId, ...claims }, SECRET)

const mockRes = () => {
  const res = { statusCode: 200, body: null }
  res.status = (c) => {
    res.statusCode = c
    return res
  }
  res.json = (b) => {
    res.body = b
    return res
  }
  return res
}

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: unique('STORE_A'), status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: unique('STORE_B'), status: 'active' }))
})

afterEach(() => {
  jest.restoreAllMocks()
})

afterAll(async () => {
  if (createdUserIds.length) {
    await db.authorizationContextSession.destroy({ where: { userId: createdUserIds }, force: true }).catch(() => {})
    await db.user.destroy({ where: { id: createdUserIds }, force: true }).catch(() => {})
  }
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true }).catch(() => {})
})

describe('P2 session validation (INV-01/02/03/17)', () => {
  test('valid JWT + live session → allowed', async () => {
    const { token } = await authenticated('ok')
    expect((await request(app).get(storeRoute(storeA.id)).set(bearer(token))).status).toBe(200)
  })

  test('login-issued token authenticates end to end', async () => {
    const { user } = await authenticated('login', { roleType: 'admin', userType: 'admin' })
    const login = await request(app).post('/auth/login').send({ userName: user.userName, password: 'Rahasia123!' })
    expect(login.status).toBe(200)
    const res = await request(app).get(ADMIN_ROUTE).set(bearer(login.body.token))
    expect([401, 403]).not.toContain(res.status)
  })

  test('JWT without sessionId → 401', async () => {
    const { user } = await authenticated('noSid')
    const token = jwt.sign({ id: user.id, roleType: 'kasir', store: storeA.id }, SECRET)
    const res = await request(app).get(storeRoute(storeA.id)).set(bearer(token))
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('SESSION_INVALID')
  })

  test('JWT with unknown sessionId → 401', async () => {
    const { user } = await authenticated('unknownSid')
    const token = jwt.sign({ id: user.id, sessionId: 'f'.repeat(64) }, SECRET)
    expect((await request(app).get(storeRoute(storeA.id)).set(bearer(token))).status).toBe(401)
  })

  test('revoked session → 401', async () => {
    const { user, session, token } = await authenticated('revoked')
    await mw.revokeContextSession(db, session.sessionId, user.id)
    const res = await request(app).get(storeRoute(storeA.id)).set(bearer(token))
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('SESSION_INVALID')
  })

  test('expired session → 401 even though the JWT itself is still valid (INV-17)', async () => {
    const { token } = await authenticated('expired', {}, { ttlMs: -1000 })
    expect(() => jwt.verify(token, SECRET)).not.toThrow()
    expect((await request(app).get(storeRoute(storeA.id)).set(bearer(token))).status).toBe(401)
  })

  test("another user's session → 401", async () => {
    const owner = await authenticated('owner')
    const intruder = await authenticated('intruder')
    const token = jwt.sign({ id: intruder.user.id, sessionId: owner.session.sessionId }, SECRET)
    expect((await request(app).get(storeRoute(storeA.id)).set(bearer(token))).status).toBe(401)
  })

  test('expired JWT → 401 (INV-01)', async () => {
    const { user, session } = await authenticated('jwtExpired')
    const token = jwt.sign(
      { id: user.id, sessionId: session.sessionId, exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET
    )
    const res = await request(app).get(storeRoute(storeA.id)).set(bearer(token))
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Token Tidak Valid')
  })
})

describe('P2 account eligibility (INV-04/18)', () => {
  test('disabled account with a live session → 403 (P1-4 shape)', async () => {
    const { user, token } = await authenticated('disabled')
    await db.user.update({ disabledAt: new Date() }, { where: { id: user.id } })
    const res = await request(app).get(storeRoute(storeA.id)).set(bearer(token))
    expect(res.status).toBe(403)
    expect(res.body.message).toBe('Akses Ditolak - Anda tidak memiliki izin')
  })

  test('soft-deleted account with a live session → 403', async () => {
    const { user, token } = await authenticated('deleted')
    await db.user.destroy({ where: { id: user.id } })
    expect((await request(app).get(storeRoute(storeA.id)).set(bearer(token))).status).toBe(403)
  })

  test('presence status "inactive" on an enabled account does not deny (INV-18)', async () => {
    const { user, token } = await authenticated('presence')
    await db.user.update({ status: 'inactive' }, { where: { id: user.id } })
    expect((await request(app).get(storeRoute(storeA.id)).set(bearer(token))).status).toBe(200)
    const ctx = await request(app).get('/auth/context').set(bearer(token))
    expect(ctx.status).toBe(200)
    expect(ctx.body.data.context.reason).not.toBe('ineligible-account')
  })
})

describe('P2 JWT claims never authorize — current DB state wins (INV-08)', () => {
  test('A: forged admin roleType on a kasir session is denied by DB role', async () => {
    const { session } = await authenticated('forgedRole')
    const token = forge(session, { roleType: 'admin', store: storeA.id })
    expect((await request(app).get(ADMIN_ROUTE).set(bearer(token))).status).toBe(403)
  })

  test('A2: forged super_admin claim cannot reach another store or platform context', async () => {
    const { session } = await authenticated('forgedSuper')
    const token = forge(session, { roleType: 'super_admin', store: null })
    expect((await request(app).get(storeRoute(storeB.id)).set(bearer(token))).status).toBe(403)
    const ctx = await request(app).get('/auth/context').set(bearer(token))
    expect(ctx.status).toBe(200)
    expect(ctx.body.data.context.isPlatformAdmin).toBe(false)
  })

  test('B: forged store claim is denied by the DB store', async () => {
    const { session } = await authenticated('forgedStore')
    const token = forge(session, { roleType: 'kasir', store: storeB.id })
    expect((await request(app).get(storeRoute(storeB.id)).set(bearer(token))).status).toBe(403)
    expect((await request(app).get(storeRoute(storeA.id)).set(bearer(token))).status).toBe(200)
  })

  test('C: DB role change takes effect on the next request with the same token', async () => {
    const { user, token } = await authenticated('roleChange')
    expect((await request(app).get(ADMIN_ROUTE).set(bearer(token))).status).toBe(403)

    await db.user.update({ roleType: 'admin', userType: 'admin' }, { where: { id: user.id } })
    expect([401, 403]).not.toContain((await request(app).get(ADMIN_ROUTE).set(bearer(token))).status)

    await db.user.update({ roleType: 'kasir', userType: 'user' }, { where: { id: user.id } })
    expect((await request(app).get(ADMIN_ROUTE).set(bearer(token))).status).toBe(403)
  })

  test('D: DB store change takes effect on the next request with the same token', async () => {
    const { user, token } = await authenticated('storeChange')
    expect((await request(app).get(storeRoute(storeB.id)).set(bearer(token))).status).toBe(403)

    await db.user.update({ store: storeB.id }, { where: { id: user.id } })
    expect((await request(app).get(storeRoute(storeB.id)).set(bearer(token))).status).toBe(200)
    expect((await request(app).get(storeRoute(storeA.id)).set(bearer(token))).status).toBe(403)
  })
})

describe('P2 fail-closed middleware contracts (INV-14/20)', () => {
  test('session lookup failure → 500 over HTTP, never 401', async () => {
    const { token } = await authenticated('dbFail')
    jest.spyOn(db.authorizationContextSession, 'findOne').mockRejectedValueOnce(new Error('db down'))
    const res = await request(app).get(storeRoute(storeA.id)).set(bearer(token))
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('db down')
  })

  test('session lookup failure never calls next()', async () => {
    const { token } = await authenticated('dbFailUnit')
    jest.spyOn(db.authorizationContextSession, 'findOne').mockRejectedValueOnce(new Error('db down'))
    const next = jest.fn()
    const res = mockRes()
    await authorization({ headers: { authorization: `Bearer ${token}` }, cookies: {} }, res, next)
    expect(res.statusCode).toBe(500)
    expect(next).not.toHaveBeenCalled()
  })

  test('hydrated req.user comes from the DB row, not from JWT claims', async () => {
    const { session } = await authenticated('hydrate')
    const token = forge(session, { roleType: 'super_admin', store: storeB.id, fullName: 'FORGED' })
    const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} }
    const next = jest.fn()
    await authorization(req, mockRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(req.user.roleType).toBe('kasir')
    expect(req.user.store).toBe(storeA.id)
    expect(req.user.fullName).not.toBe('FORGED')
    expect(req.user.sessionId).toBe(session.sessionId)
    expect(req.authSession.sessionId).toBe(session.sessionId)
  })

  test('requireRole never authenticates by itself: a bare JWT is 401', () => {
    const token = jwt.sign({ id: 1, roleType: 'admin' }, SECRET)
    const next = jest.fn()
    const res = mockRes()
    requireRole('admin')({ headers: { authorization: `Bearer ${token}` }, cookies: {} }, res, next)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  test('legacy validateStoreAccess fails closed without an authenticated session', () => {
    const next = jest.fn()
    const res = mockRes()
    validateStoreAccess({ user: { roleType: 'super_admin', store: null }, query: {}, body: {} }, res, next)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('P2 authorization context reuses the authenticated session', () => {
  test('authorization + authorizationContextMiddleware perform one session lookup and no account re-read', async () => {
    const { token } = await authenticated('oneLookup')
    const sessionLookups = jest.spyOn(db.authorizationContextSession, 'findOne')
    const accountReads = jest.spyOn(db.user, 'findByPk')

    const res = await request(app).get('/auth/context').set(bearer(token))

    expect(res.status).toBe(200)
    expect(sessionLookups).toHaveBeenCalledTimes(1)
    expect(accountReads).not.toHaveBeenCalled()
  })

  test('context middleware without canonical authentication fails closed (no JWT fallback)', async () => {
    const { token } = await authenticated('ctxAlone')
    const next = jest.fn()
    const res = mockRes()
    await mw.authorizationContextMiddleware({ headers: { authorization: `Bearer ${token}` }, cookies: {}, db }, res, next)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  test('a revoked session never reaches the canonical resolver', async () => {
    const { user, session, token } = await authenticated('ctxRevoked')
    await mw.revokeContextSession(db, session.sessionId, user.id)
    const res = await request(app).get('/auth/context').set(bearer(token))
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('SESSION_INVALID')
  })
})
