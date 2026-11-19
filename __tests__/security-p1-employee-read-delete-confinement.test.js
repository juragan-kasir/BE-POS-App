process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const PREFIX = `p1_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const sign = (claims) => signSessionToken(claims, JWT_SECRET)
const bearer = (token) => ({ Authorization: `Bearer ${token}` })

let storeA = null
let storeB = null
const actors = {}
const createdUserIds = []
let empA = null
let empB = null

const makeEmployee = async (key, storeId) => {
  const name = unique(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: 'Rahasia123!',
    fullName: name,
    userType: 'user',
    roleType: 'user',
    status: 'active',
    store: storeId,
    employeeID: `E${Date.now()}${++seq}`
  })
  createdUserIds.push(row.id)
  return row
}

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: unique('STORE_A'), status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: unique('STORE_B'), status: 'active' }))
  actors.adminA = await db.user.create({
    userName: unique('adminA'),
    email: `${unique('a')}@test.com`,
    password: 'Rahasia123!',
    fullName: 'adminA',
    userType: 'admin',
    roleType: 'admin',
    status: 'active',
    store: storeA.id
  })
  actors.superGlobal = await db.user.create({
    userName: unique('superG'),
    email: `${unique('g')}@test.com`,
    password: 'Rahasia123!',
    fullName: 'superG',
    userType: 'admin',
    roleType: 'super_admin',
    status: 'active',
    store: null
  })
  actors.superBoundA = await db.user.create({
    userName: unique('superB'),
    email: `${unique('b')}@test.com`,
    password: 'Rahasia123!',
    fullName: 'superB',
    userType: 'admin',
    roleType: 'super_admin',
    status: 'active',
    store: storeA.id
  })
  createdUserIds.push(actors.adminA.id, actors.superGlobal.id, actors.superBoundA.id)
  empA = await makeEmployee('empA', storeA.id)
  empB = await makeEmployee('empB', storeB.id)
})

afterAll(async () => {
  const rows = await db.user.findAll({ where: { id: createdUserIds }, attributes: ['id'], paranoid: false })
  const ids = rows.map((r) => r.id)
  if (ids.length) {
    await db.notification.destroy({ where: { referenceType: 'employee', referenceId: ids }, force: true }).catch(() => {})
    await db.user.destroy({ where: { id: ids }, force: true }).catch(() => {})
  }
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true }).catch(() => {})
})

const tokens = async () => ({
  adminA: await sign({ id: actors.adminA.id, roleType: 'admin', store: storeA.id }),
  superGlobal: await sign({ id: actors.superGlobal.id, roleType: 'super_admin', store: null }),
  superBoundA: await sign({ id: actors.superBoundA.id, roleType: 'super_admin', store: storeA.id })
})

const storesIn = (body) => [...new Set((body.data || []).map((e) => e.store))]

// ---- LIST ----
describe('P1 list confinement', () => {
  test.each([['omitted', undefined]])('admin %s location → own store only', async (_l, loc) => {
    const q = loc === undefined ? '' : `?location=${loc}`
    const res = await request(app).get(`/employee/get-employee${q}`).set(bearer((await tokens()).adminA))
    expect(res.status).toBe(200)
    expect(storesIn(res.body)).toEqual([storeA.id])
  })

  test('admin explicit own location → own store', async () => {
    const res = await request(app).get(`/employee/get-employee?location=${storeA.id}`).set(bearer((await tokens()).adminA))
    expect(res.status).toBe(200)
    expect(storesIn(res.body)).toEqual([storeA.id])
  })

  test('admin foreign location → 403, no foreign rows', async () => {
    const res = await request(app).get(`/employee/get-employee?location=${storeB.id}`).set(bearer((await tokens()).adminA))
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain(empB.email)
  })

  test.each([['empty', ''], ['zero', '0'], ['malformed', 'not-a-store']])('admin location %s → %s', async (_l, loc) => {
    const res = await request(app).get(`/employee/get-employee?location=${encodeURIComponent(loc)}`).set(bearer((await tokens()).adminA))
    if (loc === '') {
      expect(res.status).toBe(200)
      expect(storesIn(res.body)).toEqual([storeA.id])
    } else {
      expect(res.status).toBe(403)
    }
  })

  test('admin array location → 403', async () => {
    const res = await request(app).get(`/employee/get-employee?location=${storeA.id}&location=${storeB.id}`).set(bearer((await tokens()).adminA))
    expect(res.status).toBe(403)
  })

  test('bound omitted location → own store only', async () => {
    const res = await request(app).get('/employee/get-employee').set(bearer((await tokens()).superBoundA))
    expect(res.status).toBe(200)
    expect(storesIn(res.body)).toEqual([storeA.id])
  })

  test('bound explicit own location → own store', async () => {
    const res = await request(app).get(`/employee/get-employee?location=${storeA.id}`).set(bearer((await tokens()).superBoundA))
    expect(res.status).toBe(200)
    expect(storesIn(res.body)).toEqual([storeA.id])
  })

  test('bound foreign location → 403, no foreign rows', async () => {
    const res = await request(app).get(`/employee/get-employee?location=${storeB.id}`).set(bearer((await tokens()).superBoundA))
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain(empB.email)
  })

  test.each([['empty', ''], ['zero', '0'], ['malformed', 'xx']])('bound location %s', async (_l, loc) => {
    const res = await request(app).get(`/employee/get-employee?location=${encodeURIComponent(loc)}`).set(bearer((await tokens()).superBoundA))
    if (loc === '') {
      expect(res.status).toBe(200)
      expect(storesIn(res.body)).toEqual([storeA.id])
    } else {
      expect(res.status).toBe(403)
    }
  })

  test('bound array location → 403', async () => {
    const res = await request(app).get(`/employee/get-employee?location=${storeA.id}&location=${storeB.id}`).set(bearer((await tokens()).superBoundA))
    expect(res.status).toBe(403)
  })

  test('global omitted → unrestricted (both stores visible)', async () => {
    const res = await request(app).get('/employee/get-employee').set(bearer((await tokens()).superGlobal))
    expect(res.status).toBe(200)
    const stores = storesIn(res.body)
    expect(stores).toContain(storeA.id)
    expect(stores).toContain(storeB.id)
  })

  test('global explicit location → filtering preserved', async () => {
    const res = await request(app).get(`/employee/get-employee?location=${storeB.id}`).set(bearer((await tokens()).superGlobal))
    expect(res.status).toBe(200)
    expect(storesIn(res.body)).toEqual([storeB.id])
  })
})

// ---- GET BY ID ----
describe('P1 get-by-id confinement', () => {
  test('admin own → 200; foreign → 404 no PII; missing → 404', async () => {
    const own = await request(app).get(`/employee/get-employee/${empA.id}`).set(bearer((await tokens()).adminA))
    expect(own.status).toBe(200)
    const foreign = await request(app).get(`/employee/get-employee/${empB.id}`).set(bearer((await tokens()).adminA))
    expect(foreign.status).toBe(404)
    expect(JSON.stringify(foreign.body)).not.toContain(empB.email)
    const missing = await request(app).get('/employee/get-employee/2147480000').set(bearer((await tokens()).adminA))
    expect(missing.status).toBe(404)
  })

  test('bound own → 200; foreign → 404 no PII; missing → 404', async () => {
    const own = await request(app).get(`/employee/get-employee/${empA.id}`).set(bearer((await tokens()).superBoundA))
    expect(own.status).toBe(200)
    const foreign = await request(app).get(`/employee/get-employee/${empB.id}`).set(bearer((await tokens()).superBoundA))
    expect(foreign.status).toBe(404)
    expect(JSON.stringify(foreign.body)).not.toContain(empB.email)
    const missing = await request(app).get('/employee/get-employee/2147480000').set(bearer((await tokens()).superBoundA))
    expect(missing.status).toBe(404)
  })

  test('global own/foreign → 200; missing → 404', async () => {
    const t = (await tokens()).superGlobal
    expect((await request(app).get(`/employee/get-employee/${empA.id}`).set(bearer(t))).status).toBe(200)
    expect((await request(app).get(`/employee/get-employee/${empB.id}`).set(bearer(t))).status).toBe(200)
    expect((await request(app).get('/employee/get-employee/2147480000').set(bearer(t))).status).toBe(404)
  })
})

// ---- GET BY EMPLOYEEID ----
describe('P1 get-by-employeeID confinement', () => {
  test('admin own → 200; foreign → 404 no PII; missing → 404', async () => {
    const own = await request(app).get(`/employee/get-employee-detail/${empA.employeeID}`).set(bearer((await tokens()).adminA))
    expect(own.status).toBe(200)
    const foreign = await request(app).get(`/employee/get-employee-detail/${empB.employeeID}`).set(bearer((await tokens()).adminA))
    expect(foreign.status).toBe(404)
    expect(JSON.stringify(foreign.body)).not.toContain(empB.email)
    const missing = await request(app).get('/employee/get-employee-detail/NO_SUCH_EID').set(bearer((await tokens()).adminA))
    expect(missing.status).toBe(404)
  })

  test('bound own → 200; foreign → 404 no PII; missing → 404', async () => {
    const own = await request(app).get(`/employee/get-employee-detail/${empA.employeeID}`).set(bearer((await tokens()).superBoundA))
    expect(own.status).toBe(200)
    const foreign = await request(app).get(`/employee/get-employee-detail/${empB.employeeID}`).set(bearer((await tokens()).superBoundA))
    expect(foreign.status).toBe(404)
    expect(JSON.stringify(foreign.body)).not.toContain(empB.email)
    const missing = await request(app).get('/employee/get-employee-detail/NO_SUCH_EID').set(bearer((await tokens()).superBoundA))
    expect(missing.status).toBe(404)
  })

  test('global own/foreign → 200; missing → 404', async () => {
    const t = (await tokens()).superGlobal
    expect((await request(app).get(`/employee/get-employee-detail/${empA.employeeID}`).set(bearer(t))).status).toBe(200)
    expect((await request(app).get(`/employee/get-employee-detail/${empB.employeeID}`).set(bearer(t))).status).toBe(200)
    expect((await request(app).get('/employee/get-employee-detail/NO_SUCH_EID').set(bearer(t))).status).toBe(404)
  })
})

// ---- DELETE ----
describe('P1 delete confinement', () => {
  test('admin foreign → 404 + survives; missing → 404', async () => {
    const victim = await makeEmployee('delA1', storeB.id)
    const res = await request(app).delete(`/employee/delete-employee/${victim.id}`).set(bearer((await tokens()).adminA))
    expect(res.status).toBe(404)
    expect(await db.user.findByPk(victim.id)).not.toBeNull()
    const missing = await request(app).delete('/employee/delete-employee/2147480000').set(bearer((await tokens()).adminA))
    expect(missing.status).toBe(404)
  })

  test('admin own → 200 + deleted', async () => {
    const victim = await makeEmployee('delA2', storeA.id)
    const res = await request(app).delete(`/employee/delete-employee/${victim.id}`).set(bearer((await tokens()).adminA))
    expect(res.status).toBe(200)
    expect(await db.user.findByPk(victim.id)).toBeNull()
    await db.user.destroy({ where: { id: victim.id }, force: true }).catch(() => {})
  })

  test('bound foreign → 404 + survives (no side-effects); missing → 404', async () => {
    const victim = await makeEmployee('delB1', storeB.id)
    const before = (await db.user.findByPk(victim.id)).get({ plain: true })
    const res = await request(app).delete(`/employee/delete-employee/${victim.id}`).set(bearer((await tokens()).superBoundA))
    expect(res.status).toBe(404)
    const after = await db.user.findByPk(victim.id)
    expect(after).not.toBeNull()
    expect(after.get({ plain: true }).updatedAt).toEqual(before.updatedAt)
  })

  test('bound own → 200 + deleted', async () => {
    const victim = await makeEmployee('delB2', storeA.id)
    const res = await request(app).delete(`/employee/delete-employee/${victim.id}`).set(bearer((await tokens()).superBoundA))
    expect(res.status).toBe(200)
    expect(await db.user.findByPk(victim.id)).toBeNull()
    await db.user.destroy({ where: { id: victim.id }, force: true }).catch(() => {})
  })

  test('global foreign → 200 + deleted; missing → 404', async () => {
    const victim = await makeEmployee('delG1', storeB.id)
    const res = await request(app).delete(`/employee/delete-employee/${victim.id}`).set(bearer((await tokens()).superGlobal))
    expect(res.status).toBe(200)
    expect(await db.user.findByPk(victim.id)).toBeNull()
    await db.user.destroy({ where: { id: victim.id }, force: true }).catch(() => {})
    const missing = await request(app).delete('/employee/delete-employee/2147480000').set(bearer((await tokens()).superGlobal))
    expect(missing.status).toBe(404)
  })
})
