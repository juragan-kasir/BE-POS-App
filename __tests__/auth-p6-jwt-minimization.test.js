process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// AUTH-1 P6 — JWT claim minimization. Newly issued staff JWTs carry only the
// canonical identity/session identifiers {id, sessionId} plus iat/exp. The
// login response is unchanged. Pre-P6 tokens still carrying legacy claims
// (userName/fullName/roleType/roleId/store) stay valid until their normal
// expiry while their session/account are eligible, and those claims are
// ignored: the DB session + account row remain the only authority for HTTP
// (P2) and Socket.IO (P4).

const http = require('http')
const request = require('supertest')
const jwt = require('jsonwebtoken')
const { io: socketClient } = require('socket.io-client')
const app = require('../api/index')
const db = require('../db/models')
const generateToken = require('../utils/jwtConvert')
const { credentialWindow } = require('../utils/jwtConvert')
const { authenticateCredential } = require('../utils/authorization')
const { initSocket, getIO } = require('../api/service/socket')
const mw = require('../utils/authorizationContextMiddleware')

const SECRET = process.env.JWT_SECRET_KEY
const PASSWORD = 'Rahasia123!'
const PREFIX = `p6jwt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const bearer = (token) => ({ Authorization: `Bearer ${token}` })
const sockOpts = { transports: ['websocket'], reconnection: false, timeout: 3000 }

const MINIMAL_CLAIMS = ['exp', 'iat', 'id', 'sessionId']
const LEGACY_CLAIMS = ['userName', 'fullName', 'roleType', 'roleId', 'store']
const ADMIN_ROUTE = '/best-selling/get-chart-by-year'
const storeRoute = (storeId) => `/tax-config?store=${storeId}`

let server = null
let port = null
let tenant = null
let storeA = null
let storeB = null
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

// A canonical store-scoped actor (DR-12): tenant membership + assignment.
const makeMember = async (key, role, storeId, attrs = {}) => {
  const u = await makeUser(key, attrs)
  await db.tenantMembership.create({ userId: u.id, tenantId: tenant.id, role, status: 'ACTIVE' })
  await db.storeAssignment.create({ userId: u.id, tenantId: tenant.id, storeId })
  return u
}

const login = (user, password = PASSWORD) =>
  request(app).post('/auth/login').send({ userName: user.userName, password })

const claimKeys = (token) => Object.keys(jwt.verify(token, SECRET)).sort()

// A token exactly as pre-P6 login minted it: the legacy payload signed by the
// same helper with the credential window of its live session.
const preP6Token = async (user, overrides = {}, window = credentialWindow()) => {
  const session = await mw.createContextSession(db, { userId: user.id, expiresAt: new Date(window.exp * 1000) })
  const token = generateToken(
    {
      id: user.id,
      userName: user.userName,
      fullName: user.fullName,
      roleType: user.roleType || 'user',
      roleId: user.roleId,
      store: user.store,
      sessionId: session.sessionId,
      ...overrides
    },
    window
  )
  return { token, session }
}

const connect = (token) =>
  new Promise((resolve, reject) => {
    const sock = socketClient(`http://127.0.0.1:${port}`, { ...sockOpts, auth: token ? { token } : {} })
    const timer = setTimeout(() => {
      sock.disconnect()
      reject(new Error('socket connect timeout'))
    }, 3000)
    sock.on('connect', () => {
      clearTimeout(timer)
      resolve(sock)
    })
    sock.on('connect_error', (err) => {
      clearTimeout(timer)
      sock.disconnect()
      reject(err)
    })
  })

const joinAck = (sock, event, storeId) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 1500)
    sock.emit(event, storeId, (res) => {
      clearTimeout(timer)
      resolve(res)
    })
  })

// Resolves with the disconnect reason, or null if the socket stays up.
const disconnection = (sock, ms = 1500) =>
  new Promise((resolve) => {
    if (!sock.connected) return resolve('already-disconnected')
    const timer = setTimeout(() => resolve(null), ms)
    sock.once('disconnect', (reason) => {
      clearTimeout(timer)
      resolve(reason)
    })
  })

const serverSocketOf = (sock) => getIO().of('/').sockets.get(sock.id)

beforeAll(async () => {
  tenant = await db.tenant.create({ code: unique('tn'), name: unique('Tenant') })
  storeA = await db.location.create({ name: unique('STORE_A'), status: 'active', tenantId: tenant.id })
  storeB = await db.location.create({ name: unique('STORE_B'), status: 'active', tenantId: tenant.id })

  server = http.createServer()
  initSocket(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

afterEach(() => {
  jest.restoreAllMocks()
})

afterAll(async () => {
  const sio = getIO()
  if (sio) {
    await new Promise((resolve) => {
      sio.close(() => resolve())
      setTimeout(resolve, 1500)
    })
  }
  if (server && server.listening) await new Promise((resolve) => server.close(resolve))
  const rows = await db.user.findAll({ where: { id: createdUserIds }, attributes: ['id'], paranoid: false })
  const ids = rows.map((r) => r.id)
  if (ids.length) {
    await db.storeAssignment.destroy({ where: { userId: ids }, force: true }).catch(() => {})
    await db.tenantMembership.destroy({ where: { userId: ids }, force: true }).catch(() => {})
    await db.authorizationContextSession.destroy({ where: { userId: ids }, force: true }).catch(() => {})
    await db.user.destroy({ where: { id: ids }, force: true }).catch(() => {})
  }
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true }).catch(() => {})
  await db.tenant.destroy({ where: { id: tenant?.id }, force: true }).catch(() => {})
})

describe('P6 A: exact new claim set', () => {
  test('1: login JWT claims are exactly {id, sessionId, iat, exp}', async () => {
    const u = await makeUser('exact', { roleType: 'admin', userType: 'admin' })
    const res = await login(u)
    expect(res.status).toBe(200)
    const claims = jwt.verify(res.body.token, SECRET)
    expect(Object.keys(claims).sort()).toEqual(MINIMAL_CLAIMS)
    for (const legacy of LEGACY_CLAIMS) expect(claims).not.toHaveProperty(legacy)
    expect(claims.id).toBe(u.id)
    expect(claims.sessionId).toMatch(/^[0-9a-f]{64}$/)
    expect(Number.isInteger(claims.iat)).toBe(true)
    expect(Number.isInteger(claims.exp)).toBe(true)
  })

  test('2: lifetime policy unchanged — exp is the configured window and the session expiry', async () => {
    const u = await makeUser('lifetime')
    const res = await login(u)
    const claims = jwt.verify(res.body.token, SECRET)
    const window = credentialWindow(claims.iat * 1000)
    expect(claims.exp).toBe(window.exp)
    const session = await db.authorizationContextSession.findOne({ where: { sessionId: claims.sessionId } })
    expect(Number(session.userId)).toBe(u.id)
    expect(new Date(session.expiresAt).getTime()).toBe(claims.exp * 1000)
  })
})

describe('P6 B: login response unchanged', () => {
  const expectedKeys = async (u, extras) => {
    const row = await db.user.findByPk(u.id)
    return [...new Set([...Object.keys(row.toJSON()), 'roleType', ...extras])].sort()
  }

  test('3: admin/user userType — full pre-P6 user object, incl. the claims dropped from the JWT', async () => {
    const u = await makeUser('respAdmin', { roleType: 'admin', userType: 'admin' })
    const res = await login(u)
    expect(res.status).toBe(200)
    expect(res.body.message).toBe('Success Login')
    expect(Object.keys(res.body).sort()).toEqual(['message', 'token', 'user'])
    const { user } = res.body
    expect(Object.keys(user).sort()).toEqual(
      await expectedKeys(u, ['roleName', 'accessMenu', 'accessMenuScoped', 'storeName', 'positionName'])
    )
    expect(user.password).toBeUndefined()
    expect(user.id).toBe(u.id)
    expect(user.userName).toBe(u.userName)
    expect(user.fullName).toBe(u.fullName)
    expect(user.email).toBe(u.email)
    expect(user.roleType).toBe('admin')
    expect(user).toHaveProperty('roleId', null)
    expect(user.store).toBe(storeA.id)
    expect(user.userType).toBe('admin')
    expect(Array.isArray(user.accessMenu)).toBe(true)
    // only a super_admin with its own accessMenu is menu-scoped
    expect(user.accessMenuScoped).toBe(false)
    expect(user.roleName).toBe('Staff/Karyawan')
    expect(user.storeName).toBe(storeA.name)
    expect(typeof user.positionName).toBe('string')
  })

  test('4: other userType — pre-P6 short-branch user object unchanged', async () => {
    const u = await makeUser('respStaff', { roleType: 'kasir', userType: 'staff' })
    const res = await login(u)
    expect(res.status).toBe(200)
    expect(res.body.message).toBe('Success Login')
    const { user } = res.body
    expect(Object.keys(user).sort()).toEqual(
      await expectedKeys(u, ['roleName', 'accessMenu', 'accessMenuScoped'])
    )
    expect(user.password).toBeUndefined()
    expect(user.userName).toBe(u.userName)
    expect(user.fullName).toBe(u.fullName)
    expect(user.roleType).toBe('kasir')
    expect(user.store).toBe(storeA.id)
    expect(user.roleName).toBe('Staff/Karyawan')
  })

  test('5: login denials unchanged', async () => {
    const u = await makeUser('respDeny')
    const wrong = await login(u, 'wrong-password')
    expect(wrong.status).toBe(401)
    expect(wrong.body).toEqual({ message: 'Password Salah' })
    const missing = await request(app).post('/auth/login').send({ userName: u.userName })
    expect(missing.status).toBe(400)
    const unknown = await request(app).post('/auth/login').send({ userName: unique('nobody'), password: PASSWORD })
    expect(unknown.status).toBe(401)
    expect(unknown.body).toEqual({ message: 'User Name / Email Tidak Ditemukan' })
  })
})

describe('P6 C: legacy token compatibility', () => {
  test('6: a token carrying every legacy claim authenticates against a valid DB session', async () => {
    const u = await makeUser('legacy')
    const { token, session } = await preP6Token(u)
    expect(claimKeys(token)).toEqual([...MINIMAL_CLAIMS, ...LEGACY_CLAIMS].sort())

    const result = await authenticateCredential(token)
    expect(result.ok).toBe(true)
    expect(result.user.id).toBe(u.id)
    expect(result.user.sessionId).toBe(session.sessionId)
    expect((await request(app).get('/auth/context').set(bearer(token))).status).toBe(200)

    const sock = await connect(token)
    try {
      expect(sock.connected).toBe(true)
    } finally {
      sock.disconnect()
    }
  })

  test('7: legacy claims do not control authorization — the DB row does', async () => {
    const u = await makeUser('legacyDb', { roleType: 'kasir', store: storeA.id })
    const { token } = await preP6Token(u)
    // DB changes after issuance; the legacy claims in the token go stale.
    await db.user.update({ roleType: 'admin', userType: 'admin', store: storeB.id, fullName: 'Renamed' }, {
      where: { id: u.id }
    })
    const result = await authenticateCredential(token)
    expect(result.ok).toBe(true)
    expect(result.user.roleType).toBe('admin')
    expect(result.user.store).toBe(storeB.id)
    expect(result.user.fullName).toBe('Renamed')
    expect((await request(app).get(storeRoute(storeA.id)).set(bearer(token))).status).toBe(403)
    expect((await request(app).get(storeRoute(storeB.id)).set(bearer(token))).status).toBe(200)
  })
})

describe('P6 D: forged legacy authority claims remain ignored', () => {
  const forgedClaims = () => ({
    userName: 'forged-name',
    fullName: 'FORGED',
    roleType: 'super_admin',
    roleId: 999999,
    store: storeB.id
  })

  test('8: HTTP — forged roleType/roleId/store never override the DB-hydrated account', async () => {
    const u = await makeUser('forgedHttp', { roleType: 'kasir', userType: 'user' })
    const { token } = await preP6Token(u, forgedClaims())
    const result = await authenticateCredential(token)
    expect(result.ok).toBe(true)
    expect(result.user.userName).toBe(u.userName)
    expect(result.user.fullName).toBe(u.fullName)
    expect(result.user.roleType).toBe('kasir')
    expect(result.user.roleId).toBeNull()
    expect(result.user.store).toBe(storeA.id)
    expect((await request(app).get(ADMIN_ROUTE).set(bearer(token))).status).toBe(403)
    expect((await request(app).get(storeRoute(storeB.id)).set(bearer(token))).status).toBe(403)
    expect((await request(app).get(storeRoute(storeA.id)).set(bearer(token))).status).toBe(200)
  })

  test('9: socket — forged claims grant no room outside the canonical DB scope', async () => {
    const cashier = await makeMember('forgedSock', 'cashier', storeA.id)
    const { token } = await preP6Token(cashier, forgedClaims())
    const sock = await connect(token)
    try {
      const s = serverSocketOf(sock)
      expect(s.user.id).toBe(cashier.id)
      expect(s.user.roleType).toBe('kasir')
      expect(s.user.store).toBe(storeA.id)
      expect(s.user.fullName).toBe(cashier.fullName)
      expect((await joinAck(sock, 'join-store', storeB.id)).ok).toBe(false)
      expect((await joinAck(sock, 'join-kitchen', storeB.id)).ok).toBe(false)
      expect((await joinAck(sock, 'join-store', storeA.id)).ok).toBe(true)
    } finally {
      sock.disconnect()
    }
  })
})

describe('P6 E: minimal token socket handshake', () => {
  test('10: a login-issued minimal token completes the canonical handshake with DB-derived authority', async () => {
    const u = await makeMember('sockMin', 'store_admin', storeA.id, { roleType: 'admin', userType: 'admin' })
    const res = await login(u)
    expect(res.status).toBe(200)
    const { token } = res.body
    expect(claimKeys(token)).toEqual(MINIMAL_CLAIMS)
    const { sessionId } = jwt.decode(token)

    const sock = await connect(token)
    try {
      const s = serverSocketOf(sock)
      expect(s.user.id).toBe(u.id)
      expect(s.user.sessionId).toBe(sessionId)
      expect(s.user.roleType).toBe('admin')
      expect(s.user.store).toBe(storeA.id)
      expect(s.user.userName).toBe(u.userName)
      expect((await joinAck(sock, 'join-store', storeA.id)).ok).toBe(true)
      expect((await joinAck(sock, 'join-kitchen', storeA.id)).ok).toBe(true)
      expect((await joinAck(sock, 'join-store', storeB.id)).ok).toBe(false)

      // P4 eviction still addresses the minimal token's session.
      const gone = disconnection(sock)
      expect((await request(app).post('/auth/logout').set(bearer(token))).status).toBe(200)
      expect(await gone).toBe('io server disconnect')
    } finally {
      sock.disconnect()
    }
    await expect(connect(token)).rejects.toThrow('Unauthorized')
  })
})

describe('P6 F: stale pre-P6 token', () => {
  test('11: accepted while signature/session/account are valid and unexpired; revocation ends it', async () => {
    const u = await makeUser('staleRevoke')
    const { token } = await preP6Token(u)
    expect((await request(app).get('/auth/context').set(bearer(token))).status).toBe(200)
    expect((await request(app).post('/auth/logout').set(bearer(token))).status).toBe(200)
    const after = await request(app).get('/auth/context').set(bearer(token))
    expect(after.status).toBe(401)
    expect(after.body.code).toBe('SESSION_INVALID')
    await expect(connect(token)).rejects.toThrow('Unauthorized')
  })

  test('12: a disabled account denies it despite the legacy claims', async () => {
    const u = await makeUser('staleDisabled', { roleType: 'admin', userType: 'admin' })
    const { token } = await preP6Token(u)
    expect((await authenticateCredential(token)).ok).toBe(true)
    await db.user.update({ disabledAt: new Date() }, { where: { id: u.id } })
    const result = await authenticateCredential(token)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  test('13: an expired pre-P6 token is rejected even with a live session', async () => {
    const u = await makeUser('staleExpired')
    const now = Math.floor(Date.now() / 1000)
    const session = await mw.createContextSession(db, { userId: u.id })
    const expired = generateToken(
      {
        id: u.id,
        userName: u.userName,
        fullName: u.fullName,
        roleType: u.roleType,
        roleId: u.roleId,
        store: u.store,
        sessionId: session.sessionId
      },
      { iat: now - 120, exp: now - 60 }
    )
    const result = await authenticateCredential(expired)
    expect(result).toEqual({ ok: false, status: 401, body: { message: 'Token Tidak Valid' } })
    await expect(connect(expired)).rejects.toThrow('Unauthorized')
  })

  test('14: a pre-P6 token pointing at another user’s session is rejected', async () => {
    const owner = await makeUser('staleOwner')
    const intruder = await makeUser('staleIntruder', { roleType: 'admin', userType: 'admin' })
    const { session } = await preP6Token(owner)
    const window = credentialWindow()
    const crossed = generateToken(
      { id: intruder.id, roleType: 'super_admin', store: null, sessionId: session.sessionId },
      window
    )
    const result = await authenticateCredential(crossed)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })
})

describe('P6 G: DB failure behavior unchanged', () => {
  test('15: minimal token — HTTP fails closed with 500 and no leaked error', async () => {
    const u = await makeUser('dbfailHttp')
    const res = await login(u)
    expect(res.status).toBe(200)
    jest.spyOn(db.authorizationContextSession, 'findOne').mockRejectedValueOnce(new Error('db down secret'))
    const probe = await request(app).get('/auth/context').set(bearer(res.body.token))
    expect(probe.status).toBe(500)
    expect(probe.body).toEqual({ message: 'Internal Server Error' })
  })

  test('16: minimal and legacy tokens — canonical authentication denies 500 on lookup failure', async () => {
    const u = await makeUser('dbfailCanon')
    const minimal = (await login(u)).body.token
    const { token: legacy } = await preP6Token(u)
    for (const token of [minimal, legacy]) {
      jest.spyOn(db.authorizationContextSession, 'findOne').mockRejectedValueOnce(new Error('db down secret'))
      expect(await authenticateCredential(token)).toEqual({
        ok: false,
        status: 500,
        body: { message: 'Internal Server Error' }
      })
    }
  })

  test('17: minimal token — socket handshake fails closed without exposing the error', async () => {
    const u = await makeUser('dbfailSock')
    const res = await login(u)
    jest.spyOn(db.authorizationContextSession, 'findOne').mockRejectedValueOnce(new Error('db down secret'))
    const err = await connect(res.body.token).catch((e) => e)
    expect(err.message).toBe('Unauthorized')
  })
})
