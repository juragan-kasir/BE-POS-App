process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'
// D-08: /auth/register is closed by default; this suite tests the hardening
// of the (explicitly enabled) registration path.
process.env.PUBLIC_REGISTRATION_ENABLED = 'true'

const request = require('supertest')
const jwt = require('jsonwebtoken')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// CRIT-1 regression: POST /auth/register was a public unauthenticated
// endpoint that accepted caller-controlled `store` + `userType` and issued a
// JWT immediately. An anonymous attacker could register a user bound to a
// victim store and obtain a token scoped to it.
//
// Required invariant: public registration must NOT accept caller-controlled
// tenant/privilege fields, and must NOT immediately produce a tenant-bound JWT.

let store1 = null
let store2 = null

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const registerBody = (overrides = {}) => ({
  userName: unique('cr1user'),
  email: `${unique('cr1mail')}@test.com`,
  password: 'Rahasia123!',
  confirmPassword: 'Rahasia123!',
  ...overrides
})

beforeAll(async () => {
  store1 = await db.location.create({
    name: `CRIT1_STORE1_${Date.now()}`,
    status: 'active'
  })
  store2 = await db.location.create({
    name: `CRIT1_STORE2_${Date.now()}`,
    status: 'active'
  })
})

afterAll(async () => {
  await db.user.destroy({
    where: { store: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
})

describe('CRIT-1 public registration hardening', () => {
  test('CRIT-1-A anonymous register with victim store must not produce a tenant-bound JWT', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send(registerBody({ store: store2.id }))

    expect([200, 201]).toContain(res.status)

    // No token in the response at all
    expect(res.body?.data?.token).toBeUndefined()
    expect(res.body?.token).toBeUndefined()

    // The created user must NOT be bound to the claimed store
    expect(res.body?.data?.store).toBeNull()

    // Verify in the DB too
    const created = await db.user.findByPk(res.body?.data?.id)
    expect(created).not.toBeNull()
    expect(created.store).toBeNull()

    await db.user.destroy({ where: { id: created.id }, force: true })
  })

  test('CRIT-1-B anonymous register with userType admin must not create an admin account', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send(registerBody({ userType: 'admin' }))

    expect([200, 201]).toContain(res.status)

    const created = await db.user.findByPk(res.body?.data?.id)
    expect(created).not.toBeNull()
    // caller-controlled userType is discarded
    expect(created.userType).toBe('user')
    expect(created.roleType).toBe('user')

    await db.user.destroy({ where: { id: created.id }, force: true })
  })

  test('CRIT-1-C combined store=victim + userType=admin must fail securely', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send(
        registerBody({ store: store2.id, userType: 'admin', roleType: 'super_admin' })
      )

    expect([200, 201]).toContain(res.status)

    expect(res.body?.data?.token).toBeUndefined()
    expect(res.body?.data?.store).toBeNull()

    const created = await db.user.findByPk(res.body?.data?.id)
    expect(created).not.toBeNull()
    expect(created.store).toBeNull()
    expect(created.userType).toBe('user')
    expect(created.roleType).toBe('user')

    await db.user.destroy({ where: { id: created.id }, force: true })
  })

  test('CRIT-1-D legitimate registration flow still works (creates unassigned user, no token)', async () => {
    const body = registerBody()
    const res = await request(app).post('/auth/register').send(body)

    expect([200, 201]).toContain(res.status)
    expect(res.body?.data?.userName).toBe(body.userName)
    expect(res.body?.data?.employeeID).toBeTruthy()
    expect(res.body?.data?.store).toBeNull()
    expect(res.body?.data?.token).toBeUndefined()

    // user exists in DB and can be found by login username
    const created = await db.user.findOne({
      where: { userName: body.userName.toLowerCase() },
      paranoid: false
    })
    expect(created).not.toBeNull()

    await db.user.destroy({ where: { id: created.id }, force: true })
  })

  test('CRIT-1-E login behavior for legitimate users remains intact', async () => {
    const body = registerBody({ userName: unique('cr1login') })
    const created = await db.user.create({
      userName: body.userName,
      email: body.email,
      password: body.password,
      roleType: 'user',
      userType: 'user',
      store: store1.id,
      status: 'active'
    })

    const res = await request(app).post('/auth/login').send({
      userName: body.userName,
      password: body.password
    })

    expect(res.status).toBe(200)
    expect(res.body?.token).toBeTruthy()

    // P6: minimized JWT carries only {id, sessionId, iat, exp}; the user's
    // real store stays in the DB row and the login response, never the token.
    const decoded = jwt.verify(res.body.token, JWT_SECRET)
    expect([...Object.keys(decoded)].sort()).toEqual(['exp', 'iat', 'id', 'sessionId'])
    expect(res.body?.user?.store).toBe(store1.id)

    await db.user.destroy({ where: { id: created.id }, force: true })
  })

  test('CRIT-1-F no alternate anonymous registration path to arbitrary-store binding', async () => {
    // authenticated-only employee provisioning must reject anonymous callers
    const res = await request(app)
      .post('/employee/add-employee')
      .send({
        fullName: 'unauth',
        email: `${unique('unauth')}@test.com`,
        password: 'Rahasia123!',
        store: store2.id
      })

    expect([401, 403]).toContain(res.status)
  })

  test('CRIT-1-G a registered user logging in cannot reach a victim store even with a forged store claim', async () => {
    // register tries to bind to store2
    const reg = await request(app)
      .post('/auth/register')
      .send(registerBody({ store: store2.id, userType: 'admin' }))

    const created = await db.user.findByPk(reg.body?.data?.id)
    expect(created.store).toBeNull()

    // log in normally — token must NOT be scoped to store2
    const login = await request(app)
      .post('/auth/login')
      .send({ userName: created.userName, password: 'Rahasia123!' })

    expect(login.status).toBe(200)
    const decoded = jwt.verify(login.body.token, JWT_SECRET)
    // P6: minimized JWT carries no store claim at all.
    expect(decoded).not.toHaveProperty('store')
    expect(login.body?.user?.store).toBeNull()

    // using that token with store2 spoofing must be rejected by store validation
    const probe = await request(app)
      .get('/auth/get-user')
      .set('Authorization', `Bearer ${login.body.token}`)
      .query({ location: store2.id })

    expect([403, 400]).toContain(probe.status)

    await db.user.destroy({ where: { id: created.id }, force: true })
  })
})