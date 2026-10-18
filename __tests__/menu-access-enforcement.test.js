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
// gates — the staged rollout is tracked in api/menuRouteMap.js. Table routes
// are the reference module.

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

describe('requireMenuAction enforcement (table module)', () => {
  test('a scoped account without /table access is denied 403 MENU_ACTION_DENIED', async () => {
    const { token } = await makeAccount({
      roleType: 'kasir',
      store: location.id,
      accessMenu: [{ menu: '/pos', view: true, add: true }]
    })
    const res = await getTables(token)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('MENU_ACTION_DENIED')
  })

  test('legacy action vocabulary is normalized (read grants view)', async () => {
    const { token } = await makeAccount({
      roleType: 'admin',
      store: location.id,
      accessMenu: [{ menu: '/table', read: true }]
    })
    expect((await getTables(token)).status).toBe(200)
  })

  test('stripped menu keys match like the client (table === /table)', async () => {
    const { token } = await makeAccount({
      roleType: 'admin',
      store: location.id,
      accessMenu: [{ menu: 'table', view: true }]
    })
    expect((await getTables(token)).status).toBe(200)
  })

  test('a view-only account cannot use the add action', async () => {
    const { token } = await makeAccount({
      roleType: 'admin',
      store: location.id,
      accessMenu: [{ menu: '/table', view: true }]
    })
    const res = await createTable(token, unique('C02_DENIED_TABLE'))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('MENU_ACTION_DENIED')
  })

  test('a granted add action passes the menu gate', async () => {
    const { token } = await makeAccount({
      roleType: 'admin',
      store: location.id,
      accessMenu: [{ menu: '/table', add: true }]
    })
    const res = await createTable(token, unique('C02_GRANTED_TABLE'))
    expect(res.status).toBe(201)
    if (res.body?.data?.id || res.body?.id) tables.push(res.body?.data?.id || res.body?.id)
  })

  test('a menu-scoped super_admin is enforced, not bypassed', async () => {
    const { token } = await makeAccount({
      roleType: 'super_admin',
      accessMenu: [{ menu: '/pos', view: true }]
    })
    const res = await getTables(token)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('MENU_ACTION_DENIED')
  })

  test('a super_admin without its own menu bypasses the menu gate', async () => {
    const { token } = await makeAccount({ roleType: 'super_admin', accessMenu: [] })
    expect((await getTables(token)).status).toBe(200)
  })

  test('a role-provided menu grants exactly like an own menu (login fallback)', async () => {
    const role = await db.role.create({
      name: unique('C02 Role Table'),
      roleType: 'admin',
      store: null,
      accessMenu: JSON.stringify([{ menu: '/table', view: true }])
    })
    roles.push(role.id)
    const { token } = await makeAccount({
      roleType: 'admin',
      store: location.id,
      roleId: role.id,
      accessMenu: []
    })
    expect((await getTables(token)).status).toBe(200)
  })

  test('a role-provided menu without /table denies', async () => {
    const role = await db.role.create({
      name: unique('C02 Role Inv'),
      roleType: 'admin',
      store: null,
      accessMenu: JSON.stringify([{ menu: '/inventory', view: true }])
    })
    roles.push(role.id)
    const { token } = await makeAccount({
      roleType: 'admin',
      store: location.id,
      roleId: role.id,
      accessMenu: []
    })
    const res = await getTables(token)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('MENU_ACTION_DENIED')
  })
})
