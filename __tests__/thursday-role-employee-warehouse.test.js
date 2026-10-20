process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { Op } = require('sequelize')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

// Owner flow (go-live demo): create a role, create an employee on it, create
// a warehouse — each step exactly as the FE pages send it — for every kind of
// account. Records the observed outcome per actor/step (printed as a matrix).

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const PASSWORD = 'Rahasia123!'
const P = `thu_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const uniq = (k) => `${P}_${k}_${++seq}`.toLowerCase()
const bearer = (t) => ({ Authorization: `Bearer ${t}` })

let tenant, storeA
const actors = {}
const tokens = {}
const created = { users: [], roles: [], locations: [] }
const results = []

const makeUser = async (key, attrs) => {
  const name = uniq(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: PASSWORD,
    fullName: name,
    userType: 'user',
    status: 'active',
    ...attrs
  })
  created.users.push(row.id)
  return row
}

const MENU = (href) => ({ menu: href, view: true, add: true, edit: true, delete: true })

// FE src/page/user/AddRole.jsx payload (no roleType, no store)
const addRole = (token, extra = {}) =>
  request(app)
    .post('/role/add-new-role')
    .set(bearer(token))
    .send({
      name: uniq('ROLE_KASIR_PAGI'),
      description: '',
      status: 'active',
      accessMenu: [MENU('/home'), MENU('/cash-register/current')],
      ...extra
    })

// FE src/page/employee/AddEmployee.jsx → buildFormData (multipart)
const addEmployee = (token, { roleId, store }) => {
  const name = uniq('emp')
  let req = request(app).post('/employee/add-employee').set(bearer(token))
  const fields = {
    userName: name,
    email: `${name}@test.com`,
    password: PASSWORD,
    confirmPassword: PASSWORD,
    fullName: `Karyawan ${name}`,
    store: store != null ? String(store) : '',
    roleId: roleId != null ? String(roleId) : undefined,
    status: 'active',
    shift: ''
  }
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) req = req.field(k, v)
  return req.then((res) => ({ res, userName: name }))
}

// FE src/page/location/AddLocation.jsx → multipart `data` JSON
const addWarehouse = (token, extra = {}) =>
  request(app)
    .post('/location/add-new-location')
    .set(bearer(token))
    .field(
      'data',
      JSON.stringify({
        name: uniq('GUDANG'),
        category: 'Warehouse',
        status: 'active',
        address: 'Jl. Gudang 1',
        phoneNumber: '081200000000',
        ...extra
      })
    )

const record = (actor, step, res, note = '') => {
  const body = res.body || {}
  results.push({
    actor,
    step,
    status: res.status,
    message: String(body.message || body.error || body.code || '').slice(0, 90),
    note
  })
  if (res.status >= 500) console.error(step, actor, body)
}

beforeAll(async () => {
  tenant = await db.tenant.create({ code: uniq('TEN'), name: 'Thursday Tenant', status: 'active' })
  storeA = await db.location.create({ name: uniq('STORE_A'), status: 'active', tenantId: tenant.id })
  created.locations.push(storeA.id)

  actors.superGlobal = await makeUser('sa_global', { roleType: 'super_admin', userType: 'admin', store: null })
  actors.superBound = await makeUser('sa_bound', { roleType: 'super_admin', userType: 'admin', store: storeA.id })
  actors.admin = await makeUser('admin', { roleType: 'admin', store: storeA.id })
  actors.kasir = await makeUser('kasir', { roleType: 'kasir', store: storeA.id })
  actors.user = await makeUser('user', { roleType: 'user', store: storeA.id })
  for (const [key, u] of Object.entries(actors)) {
    tokens[key] = await signSessionToken(
      { id: u.id, userName: u.userName, roleType: u.roleType, store: u.store },
      JWT_SECRET
    )
  }
})

afterAll(async () => {
  console.log('\nTHURSDAY MATRIX\n' + JSON.stringify(results, null, 1))
  const users = await db.user.findAll({
    where: { [Op.or]: [{ id: created.users }, { userName: { [Op.like]: `${P}%` } }] },
    attributes: ['id'],
    paranoid: false
  })
  const userIds = users.map((u) => u.id)
  await db.tenantMembership.destroy({ where: { tenantId: tenant.id }, force: true }).catch(() => {})
  const locs = await db.location.findAll({ where: { name: { [Op.like]: `${P}%` } }, attributes: ['id'], paranoid: false })
  await db.location.destroy({ where: { id: locs.map((l) => l.id).filter((id) => id !== storeA.id) }, force: true }).catch(() => {})
  await db.notification.destroy({ where: { referenceType: 'employee', referenceId: userIds }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: userIds }, force: true }).catch(() => {})
  await db.auditLog.destroy({ where: { userId: userIds }, force: true }).catch(() => {})
  await db.user.destroy({ where: { id: userIds }, force: true }).catch((e) => console.warn('user cleanup', e.message))
  await db.role.destroy({ where: { name: { [Op.like]: `${P}%` } }, force: true }).catch(() => {})
  await db.location.destroy({ where: { id: storeA.id }, force: true }).catch(() => {})
  await db.tenant.destroy({ where: { id: tenant.id }, force: true }).catch(() => {})
})

describe.each(['superGlobal', 'superBound', 'admin', 'kasir', 'user'])('%s', (actor) => {
  let roleId = null
  let roleRow = null

  test('1. create role (FE payload)', async () => {
    const res = await addRole(tokens[actor])
    record(actor, '1 add role (FE: no roleType)', res)
    if (res.status === 200) {
      roleId = res.body.data.id
      roleRow = await db.role.findByPk(roleId)
      results[results.length - 1].note = `roleType=${roleRow.roleType} store=${roleRow.store}`
    }
  })

  test('1b. create role with explicit roleType kasir', async () => {
    const res = await addRole(tokens[actor], { roleType: 'kasir' })
    record(actor, '1b add role roleType=kasir', res)
    if (res.status === 200) {
      const row = await db.role.findByPk(res.body.data.id)
      results[results.length - 1].note = `roleType=${row.roleType} store=${row.store}`
      roleId = res.body.data.id
      roleRow = row
    }
  })

  test('2. create employee on that role', async () => {
    const fallbackRole =
      roleId ||
      (await db.role.findOne({ where: { roleType: 'kasir', store: { [Op.or]: [null, storeA.id] } } }))?.id ||
      null
    const { res, userName } = await addEmployee(tokens[actor], { roleId: fallbackRole, store: storeA.id })
    record(actor, '2 add employee', res)
    const emp = await db.user.findOne({ where: { userName } })
    if (emp) {
      created.users.push(emp.id)
      results[results.length - 1].note = `roleType=${emp.roleType} store=${emp.store} roleId=${emp.roleId}`
      // 2b: the new employee logs in and opens the cashier's register endpoint
      const login = await request(app).post('/auth/login').send({ userName, password: PASSWORD })
      record(actor, '2b new employee login', login, login.body?.user ? `roleType=${login.body.user.roleType}` : '')
      if (login.body?.token) {
        const reg = await request(app)
          .get(`/cash-register/current?store=${storeA.id}`)
          .set(bearer(login.body.token))
        record(actor, '2c employee GET register', reg)
      }
    }
  })

  test('3. create warehouse (FE payload, no tenantId)', async () => {
    const res = await addWarehouse(tokens[actor])
    record(actor, '3 add gudang (no tenantId)', res)
  })

  test('3b. create warehouse with tenantId', async () => {
    const res = await addWarehouse(tokens[actor], { tenantId: tenant.id })
    record(actor, '3b add gudang (tenantId)', res)
  })

  test('3c. store-bound super_admin with a tenant_admin membership creates the gudang', async () => {
    if (actor !== 'superBound') return
    // granted the way production will: the global super admin calls the API
    const grant = await request(app)
      .post('/memberships')
      .set(bearer(tokens.superGlobal))
      .send({ userId: actors.superBound.id, tenantId: tenant.id, role: 'tenant_admin', reason: 'owner manages outlets' })
    record(actor, '3c0 POST /memberships tenant_admin', grant, JSON.stringify(grant.body?.data?.membership || {}).slice(0, 60))
    // the grant revokes the account's sessions: sign in again
    tokens[actor] = await signSessionToken(
      { id: actors.superBound.id, userName: actors.superBound.userName, roleType: 'super_admin', store: storeA.id },
      JWT_SECRET
    )
    const res = await addWarehouse(tokens[actor])
    record(actor, '3c gudang w/ tenant_admin membership', res)
    const res2 = await addWarehouse(tokens[actor], { tenantId: tenant.id })
    record(actor, '3d gudang w/ membership + tenantId', res2)
    if (res2.body?.data?.id || res.body?.data?.id) {
      const loc = await db.location.findByPk(res2.body?.data?.id || res.body?.data?.id)
      results[results.length - 1].note = `tenantId=${loc?.tenantId} category=${loc?.category} status=${loc?.status}`
    }
  })

  test('4. list roles / employees', async () => {
    const roles = await request(app).get('/role/get-role').set(bearer(tokens[actor]))
    record(actor, '4a get roles', roles, Array.isArray(roles.body?.data) ? `n=${roles.body.data.length}` : '')
    const emps = await request(app)
      .get(`/employee/get-employee?store=${storeA.id}`)
      .set(bearer(tokens[actor]))
    record(actor, '4b get employees', emps)
  })
})
