process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// The reset flow emails the plaintext token; capture it from the mocked
// transport instead of letting the non-production fallback print it.
jest.mock('../utils/emailService', () => {
  const actual = jest.requireActual('../utils/emailService')
  return { ...actual, sendEmail: jest.fn().mockResolvedValue({ ok: true }) }
})

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { sendEmail } = require('../utils/emailService')
const { hashResetToken, resetTokenMatches } = require('../utils/resetToken')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const PASSWORD = 'Rahasia123!'
const SENSITIVE = ['password', 'resetToken', 'resetTokenExpires', 'confirmPassword']

// P0-1 regression: GET /role/get-users-by-role only scoped `admin` callers,
// every other authenticated account (including a self-registered one) got
// the whole user table, and user rows carried the plaintext password-reset
// token. Chained with the public reset endpoints that was an account
// takeover of any user, super_admin included.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const sign = (claims) => signSessionToken(claims, JWT_SECRET)
const bearer = (token) => ({ Authorization: `Bearer ${token}` })

const expectNoSecrets = (value) => {
  const text = JSON.stringify(value)
  for (const field of SENSITIVE) expect(text).not.toContain(`"${field}"`)
}

const emailedToken = () => {
  const mail = sendEmail.mock.calls[sendEmail.mock.calls.length - 1][0]
  const match = mail.text.match(/token=([a-f0-9]{64})/)
  return match ? match[1] : null
}

let storeA = null
let storeB = null
const users = {}
const createdUserIds = []

const makeUser = async (key, attrs) => {
  const row = await db.user.create({
    // login and reset lowercase their input
    userName: unique(`p01_${key}`).toLowerCase(),
    email: `${unique(`p01_${key}`)}@test.com`.toLowerCase(),
    password: PASSWORD,
    userType: 'user',
    status: 'active',
    ...attrs
  })
  users[key] = row
  createdUserIds.push(row.id)
  return row
}

beforeAll(async () => {
  storeA = await db.location.create({ name: unique('P01_STORE_A'), status: 'active' })
  storeB = await db.location.create({ name: unique('P01_STORE_B'), status: 'active' })

  const future = new Date(Date.now() + 10 * 60 * 1000)
  await makeUser('adminA', { roleType: 'admin', userType: 'admin', store: storeA.id })
  await makeUser('kasirA', { roleType: 'kasir', store: storeA.id })
  await makeUser('userA', {
    roleType: 'user',
    store: storeA.id,
    resetToken: hashResetToken('a'.repeat(64)),
    resetTokenExpires: future
  })
  await makeUser('userB', {
    roleType: 'user',
    store: storeB.id,
    resetToken: hashResetToken('b'.repeat(64)),
    resetTokenExpires: future
  })
  await makeUser('superGlobal', { roleType: 'super_admin', userType: 'admin', store: null })
  await makeUser('superA', { roleType: 'super_admin', userType: 'admin', store: storeA.id })
  await makeUser('superB', { roleType: 'super_admin', userType: 'admin', store: storeB.id })
})

afterAll(async () => {
  await db.user.destroy({ where: { id: createdUserIds }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true })
})

const tokens = async () => ({
  adminA: await sign({ id: users.adminA.id, roleType: 'admin', store: storeA.id }),
  kasirA: await sign({ id: users.kasirA.id, roleType: 'kasir', store: storeA.id }),
  userA: await sign({ id: users.userA.id, roleType: 'user', store: storeA.id }),
  superGlobal: await sign({ id: users.superGlobal.id, roleType: 'super_admin', store: null }),
  superA: await sign({ id: users.superA.id, roleType: 'super_admin', store: storeA.id })
})

const listUsers = (token, query = {}) =>
  request(app).get('/role/get-users-by-role').query(query).set(bearer(token))

describe('TEST-1 user serialization never carries credentials', () => {
  test('default reads do not load password / resetToken / resetTokenExpires', async () => {
    const row = await db.user.findByPk(users.userA.id)
    for (const field of ['password', 'resetToken', 'resetTokenExpires']) {
      expect(row.get(field)).toBeUndefined()
    }
  })

  test('an instance carrying credentials serializes without them', async () => {
    const row = await db.user.scope('withCredentials').findByPk(users.userA.id)
    expect(row.password).toBeTruthy()
    expect(row.resetToken).toBeTruthy()
    expectNoSecrets(row.toJSON())
    expectNoSecrets(JSON.parse(JSON.stringify(row)))
  })

  test('a freshly created instance serializes without the password hash', () => {
    expectNoSecrets(users.adminA.toJSON())
  })

  test('get-user (by location), employee list and change-user-status responses carry no credentials', async () => {
    const t = (await tokens())
    const byLocation = await request(app)
      .get('/auth/get-user')
      .query({ location: storeA.id })
      .set(bearer(t.adminA))
    expect(byLocation.status).toBe(200)
    expect(byLocation.body.data.some((u) => u.id === users.userA.id)).toBe(true)
    expectNoSecrets(byLocation.body)

    const employees = await request(app).get('/employee/get-employee').set(bearer(t.adminA))
    expect(employees.status).toBe(200)
    expectNoSecrets(employees.body)

    // RETURNING path: the updated row comes back with every column.
    const status = await request(app)
      .put('/auth/change-user-status')
      .set(bearer(t.adminA))
      .send({ id: users.userA.id, status: 'active' })
    expect(status.status).toBe(200)
    expect(status.body.data.id).toBe(users.userA.id)
    expectNoSecrets(status.body)
  })

  test('change-profile-user response carries no credentials', async () => {
    const res = await request(app)
      .put('/auth/change-profile-user')
      .set(bearer((await tokens()).adminA))
      .send({ id: users.userA.id, userType: 'user', store: storeA.id })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(users.userA.id)
    expectNoSecrets(res.body)
  })
})

describe('TEST-2 get-users-by-role requires user-management authority', () => {
  test.each(['userA', 'kasirA'])('%s is denied', async (key) => {
    const res = await listUsers((await tokens())[key])
    expect(res.status).toBe(403)
    expect(res.body.data).toBeUndefined()
  })

  test('unauthenticated request is 401', async () => {
    const res = await request(app).get('/role/get-users-by-role')
    expect(res.status).toBe(401)
  })
})

describe('TEST-3 store-scoped enumeration', () => {
  test('admin of store A receives only store A users', async () => {
    const res = await listUsers((await tokens()).adminA)
    expect(res.status).toBe(200)
    const ids = res.body.data.map((u) => u.id)
    expect(ids).toEqual(expect.arrayContaining([users.adminA.id, users.kasirA.id, users.userA.id]))
    expect(ids).not.toContain(users.userB.id)
    expect(res.body.data.every((u) => u.store === storeA.id)).toBe(true)
    expectNoSecrets(res.body)
  })

  test('a client-supplied foreign store cannot broaden the scope', async () => {
    const res = await listUsers((await tokens()).adminA, { store: storeB.id })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain(users.userB.userName)
  })

  test('an admin without a store assignment is denied', async () => {
    // AUTH-1 P2: "no store assignment" must be the account's state, not a claim.
    const unassigned = await makeUser('adminNoStore', { roleType: 'admin', userType: 'admin', store: null })
    const res = await listUsers(await sign({ id: unassigned.id, roleType: 'admin', store: null }))
    expect(res.status).toBe(403)
  })
})

describe('TEST-4 super_admin filter isolation', () => {
  test('admin asking for roleType=super_admin receives no super_admin accounts', async () => {
    const res = await listUsers((await tokens()).adminA, { roleType: 'super_admin' })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  test('store-bound super_admin sees only its own store, never global or foreign super_admins', async () => {
    const res = await listUsers((await tokens()).superA, { roleType: 'super_admin' })
    expect(res.status).toBe(200)
    const ids = res.body.data.map((u) => u.id)
    expect(ids).toContain(users.superA.id)
    expect(ids).not.toContain(users.superGlobal.id)
    expect(ids).not.toContain(users.superB.id)
    expect(res.body.data.every((u) => u.store === storeA.id)).toBe(true)
  })

  test('an unknown roleType filter is rejected', async () => {
    const res = await listUsers((await tokens()).adminA, { roleType: 'owner' })
    expect(res.status).toBe(400)
  })
})

describe('TEST-7 authorized listing keeps working', () => {
  test('admin roleType filter is honored within the store', async () => {
    const res = await listUsers((await tokens()).adminA, { roleType: 'kasir' })
    expect(res.status).toBe(200)
    expect(res.body.data.map((u) => u.id)).toEqual([users.kasirA.id])
  })

  test('global super_admin lists across stores with the role filter applied', async () => {
    const all = await listUsers((await tokens()).superGlobal)
    expect(all.status).toBe(200)
    const ids = all.body.data.map((u) => u.id)
    expect(ids).toEqual(expect.arrayContaining([users.userA.id, users.userB.id, users.superB.id]))
    expectNoSecrets(all.body)

    const supers = await listUsers((await tokens()).superGlobal, { roleType: 'super_admin' })
    expect(supers.status).toBe(200)
    expect(supers.body.data.every((u) => u.roleType === 'super_admin')).toBe(true)
    expect(supers.body.data.map((u) => u.id)).toEqual(
      expect.arrayContaining([users.superGlobal.id, users.superA.id, users.superB.id])
    )
  })
})

describe('reset token storage (unit)', () => {
  const plain = 'c'.repeat(64)

  test('stored form is a prefixed digest, never the token itself', () => {
    const stored = hashResetToken(plain)
    expect(stored.startsWith('sha256:')).toBe(true)
    expect(stored).not.toContain(plain)
  })

  test('verifies the emailed token and rejects everything else', () => {
    const stored = hashResetToken(plain)
    expect(resetTokenMatches(stored, plain)).toBe(true)
    expect(resetTokenMatches(stored, 'd'.repeat(64))).toBe(false)
    expect(resetTokenMatches(stored, stored)).toBe(false)
    expect(resetTokenMatches(stored, '')).toBe(false)
    expect(resetTokenMatches(stored, undefined)).toBe(false)
    expect(resetTokenMatches(null, plain)).toBe(false)
    expect(resetTokenMatches('', plain)).toBe(false)
  })

  test('a token issued before hashing (plaintext row) stays redeemable until it expires', () => {
    expect(resetTokenMatches(plain, plain)).toBe(true)
    expect(resetTokenMatches(plain, 'd'.repeat(64))).toBe(false)
  })
})

describe('TEST-5/6 password reset flow', () => {
  test('legitimate reset: token is emailed, stored hashed, never returned, and redeemable once', async () => {
    const owner = await makeUser('resetOwner', { roleType: 'user', store: storeA.id })

    const requested = await request(app)
      .post('/auth/reset-password/request')
      .send({ email: owner.email })
    expect(requested.status).toBe(200)
    expectNoSecrets(requested.body)

    const token = emailedToken()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(requested.body)).not.toContain(token)

    const stored = await db.user.scope('withCredentials').findByPk(owner.id)
    expect(stored.resetToken).not.toBe(token)
    expect(stored.resetToken).not.toContain(token)
    expect(stored.resetToken).toBe(hashResetToken(token))

    const reset = await request(app).post('/auth/reset-password').send({
      email: owner.email,
      token,
      newPassword: 'BaruSekali1!',
      confirmPassword: 'BaruSekali1!'
    })
    expect(reset.status).toBe(200)

    const cleared = await db.user.scope('withCredentials').findByPk(owner.id)
    expect(cleared.resetToken).toBeNull()
    expect(cleared.resetTokenExpires).toBeNull()

    const login = await request(app)
      .post('/auth/login')
      .send({ userName: owner.userName, password: 'BaruSekali1!' })
    expect(login.status).toBe(200)
    expectNoSecrets(login.body)
  })
})

describe('P0-1 exploit chain is broken', () => {
  test('register → login → enumerate → request reset → obtain token → reset victim fails', async () => {
    const victim = await makeUser('victim', { roleType: 'super_admin', userType: 'admin', store: null })

    // 1. public registration — closed by default (D-08); opened here to prove
    // the chain stays broken even where an operator enables it.
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true'
    const userName = unique('p01_attacker')
    const registered = await request(app).post('/auth/register').send({
      userName,
      email: `${userName}@test.com`,
      password: PASSWORD,
      confirmPassword: PASSWORD
    })
    delete process.env.PUBLIC_REGISTRATION_ENABLED
    expect(registered.status).toBe(200)
    const attacker = await db.user.findOne({ where: { userName: userName.toLowerCase() } })
    createdUserIds.push(attacker.id)

    // 2. login still works (CRIT-1-E contract)
    const login = await request(app).post('/auth/login').send({ userName, password: PASSWORD })
    expect(login.status).toBe(200)
    const attackerToken = login.body.token

    // 3. enumeration of super_admins is denied
    const listed = await listUsers(attackerToken, { roleType: 'super_admin' })
    expect(listed.status).toBe(403)
    expect(JSON.stringify(listed.body)).not.toContain(victim.email)

    // 4. the public reset request discloses nothing
    const requested = await request(app)
      .post('/auth/reset-password/request')
      .send({ email: victim.email })
    expect(requested.status).toBe(200)
    expectNoSecrets(requested.body)
    const mailedToken = emailedToken()
    expect(JSON.stringify(requested.body)).not.toContain(mailedToken)

    // 5. even the stored value is not a usable token
    const stored = await db.user.scope('withCredentials').findByPk(victim.id)
    expect(stored.resetToken).not.toContain(mailedToken)
    const reset = await request(app).post('/auth/reset-password').send({
      email: victim.email,
      token: stored.resetToken,
      newPassword: 'Diambil123!',
      confirmPassword: 'Diambil123!'
    })
    expect(reset.status).toBe(400)

    // 6. the victim keeps its password — no takeover
    const victimLogin = await request(app)
      .post('/auth/login')
      .send({ userName: victim.userName, password: PASSWORD })
    expect(victimLogin.status).toBe(200)
    const hijack = await request(app)
      .post('/auth/login')
      .send({ userName: victim.userName, password: 'Diambil123!' })
    expect(hijack.status).toBe(401)
  })
})
