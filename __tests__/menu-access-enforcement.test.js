process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

// DR-24 C-02 / DR-12 §35.4: the role accessMenu is a server-side permission
// list too, not only a client rendering hint. `requireMenuAction` mirrors the
// FE semantics exactly (legacy action vocabulary, stripped menu keys, scoped
// super_admin, bypass for menu-less super_admin) and confines any account
// that carries an effective menu to it. Accounts without any effective menu
// (legacy fixtures/roles not yet migrated) keep the prior role/capability
// gates — the staged rollout is tracked in api/menuRouteMap.js. Wave 2
// (utils/menuWriteGate.js): reads stay open — the cashier picks tables at
// checkout — and writes follow the /table-list menu (legacy /table too).

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
let uniqueSeq = 0
const unique = (prefix) => `${prefix}_${Date.now()}_${++uniqueSeq}`

let location = null
const users = []
const roles = []
const tables = []

const makeAccount = async ({ roleType = 'admin', accessMenu = [], roleId = null, store = null }) => {
  const user = await db.user.create({
    userName: unique('c02'),
    email: `${unique('c02mail')}@test.com`,
    roleType,
    userType: roleType === 'kasir' || roleType === 'user' ? 'user' : 'admin',
    store,
    status: 'active',
    accessMenu,
    roleId
  })
  users.push(user.id)
  const token = await signSessionToken(
    { id: user.id, userName: user.userName, roleType, store },
    JWT_SECRET
  )
  return { user, token }
}

const getTables = (token) =>
  request(app).get('/table/get-tables').set('Authorization', `Bearer ${token}`).query({ store: location.id })

const createTable = (token, name) =>
  request(app)
    .post('/table/create')
    .set('Authorization', `Bearer ${token}`)
    .send({ store: location.id, name })

beforeAll(async () => {
  location = await db.location.create({ name: unique('C02_STORE'), status: 'active' })
})

afterAll(async () => {
  await db.authorizationContextSession.destroy({ where: { userId: users } })
  await db.table.destroy({ where: { id: tables }, force: true })
  await db.user.destroy({ where: { id: users }, force: true })
  await db.role.destroy({ where: { id: roles }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

describe('menu write gate (table module)', () => {
  const expectDenied = (res) => {
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('MENU_ACTION_DENIED')
  }
  const expectCreated = (res) => {
    expect(res.status).toBe(201)
    if (res.body?.data?.id || res.body?.id) tables.push(res.body?.data?.id || res.body?.id)
  }

  test('reads stay open: a kasir without a table menu can still load tables at checkout', async () => {
    const { token } = await makeAccount({
      roleType: 'kasir',
      store: location.id,
      accessMenu: [{ menu: '/home', view: true }]
    })
    expect((await getTables(token)).status).toBe(200)
  })

  test('a scoped account without a table menu cannot create a table', async () => {
    const { token } = await makeAccount({
      roleType: 'admin',
      store: location.id,
      accessMenu: [{ menu: '/pos', view: true, add: true }]
    })
    expectDenied(await createTable(token, unique('C02_NO_MENU')))
  })

  test('the role-matrix key /table-list grants table writes', async () => {
    const { token } = await makeAccount({
      roleType: 'admin',
      store: location.id,
      accessMenu: [{ menu: '/table-list', view: true, add: true }]
    })
    expectCreated(await createTable(token, unique('C02_MATRIX_KEY')))
  })

  test('legacy keys and vocabulary still grant (/table create, stripped "table")', async () => {
    for (const accessMenu of [[{ menu: '/table', create: true }], [{ menu: 'table', add: true }]]) {
      const { token } = await makeAccount({ roleType: 'admin', store: location.id, accessMenu })
      expectCreated(await createTable(token, unique('C02_LEGACY')))
    }
  })

  test('a view-only account cannot use the add action', async () => {
    const { token } = await makeAccount({
      roleType: 'admin',
      store: location.id,
      accessMenu: [{ menu: '/table-list', view: true }]
    })
    expectDenied(await createTable(token, unique('C02_DENIED_TABLE')))
  })

  test('a menu-scoped super_admin is enforced, not bypassed', async () => {
    const { token } = await makeAccount({
      roleType: 'super_admin',
      accessMenu: [{ menu: '/pos', view: true }]
    })
    expectDenied(await createTable(token, unique('C02_SCOPED_SA')))
  })

  test('a super_admin without its own menu bypasses the menu gate', async () => {
    const { token } = await makeAccount({ roleType: 'super_admin', accessMenu: [] })
    expectCreated(await createTable(token, unique('C02_GLOBAL_SA')))
  })

  test('a role-provided menu grants exactly like an own menu (login fallback)', async () => {
    const grant = await db.role.create({
      name: unique('C02 Role Table'),
      roleType: 'admin',
      store: null,
      accessMenu: JSON.stringify([{ menu: '/table-list', add: true }])
    })
    const deny = await db.role.create({
      name: unique('C02 Role Inv'),
      roleType: 'admin',
      store: null,
      accessMenu: JSON.stringify([{ menu: '/inventory', view: true }])
    })
    roles.push(grant.id, deny.id)
    const granted = await makeAccount({ roleType: 'admin', store: location.id, roleId: grant.id })
    const denied = await makeAccount({ roleType: 'admin', store: location.id, roleId: deny.id })
    expectCreated(await createTable(granted.token, unique('C02_ROLE_OK')))
    expectDenied(await createTable(denied.token, unique('C02_ROLE_NO')))
  })
})
