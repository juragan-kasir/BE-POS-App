process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { actionFor } = require('../utils/menuWriteGate')

// Role Management checkboxes guard back-office writes on the server with the
// FE rule (wave 2, utils/menuWriteGate.js); reads, cashier flows and menu-less
// accounts are untouched. Plus: salary hidden from non-admins, audit rows for
// report settings.

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
let seq = 0
const unique = (p) => `${p}_${Date.now()}_${++seq}`

let location
const users = []

const account = async ({ roleType = 'admin', accessMenu = [], extra = {} } = {}) => {
  const user = await db.user.create({
    userName: unique('rah'),
    email: `${unique('rah')}@test.com`,
    roleType,
    userType: roleType === 'kasir' || roleType === 'user' ? 'user' : 'admin',
    store: roleType === 'super_admin' && !accessMenu.length ? null : location.id,
    status: 'active',
    accessMenu,
    ...extra
  })
  users.push(user.id)
  const token = await signSessionToken(
    { id: user.id, userName: user.userName, roleType, store: user.store },
    JWT_SECRET
  )
  return { user, token }
}

const as = (token, method, path) =>
  request(app)[method](path).set('Authorization', `Bearer ${token}`).query({ store: location.id })
const menuDenied = (res) => res.status === 403 && res.body?.code === 'MENU_ACTION_DENIED'

beforeAll(async () => {
  location = await db.location.create({ name: unique('RAH_STORE'), status: 'active' })
})

afterAll(async () => {
  await db.authorizationContextSession.destroy({ where: { userId: users } })
  await db.auditLog.destroy({ where: { userId: users }, force: true, __auditMaintenance: true })
  const links = await db.category_store.findAll({ where: { storeId: location.id }, attributes: ['categoryId'] }).catch(() => [])
  await db.category_store.destroy({ where: { storeId: location.id } }).catch(() => {})
  if (links.length) await db.category.destroy({ where: { id: links.map((l) => l.categoryId) }, force: true })
  await db.user.destroy({ where: { id: users }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

describe('actionFor mirrors the role matrix vocabulary', () => {
  test.each([
    ['POST', '/add-new-category', 'add'],
    ['PUT', '/edit-category/3', 'edit'],
    ['DELETE', '/delete-category/3', 'delete'],
    ['POST', '/upload-excel', 'import'],
    ['POST', '/export-selected', 'export'],
    ['PATCH', '/approve/3', 'approve'],
    ['PUT', '/update-status/3', 'update-status'],
    ['POST', '/archive-location', 'edit'],
    ['PUT', '/receive/3', 'edit']
  ])('%s %s → %s', (method, path, action) => {
    expect(actionFor(method, path)).toBe(action)
  })
})

describe('menu write gate on back-office modules', () => {
  const addCategory = (token) =>
    as(token, 'post', '/category/add-new-category').send({ name: unique('RAH_CAT'), store: location.id })

  test('a view-only role cannot add a category; an add grant passes the gate', async () => {
    const viewer = await account({ accessMenu: [{ menu: '/category-list', view: true }] })
    expect(menuDenied(await addCategory(viewer.token))).toBe(true)
    const adder = await account({ accessMenu: [{ menu: '/category-list', view: true, add: true }] })
    expect(menuDenied(await addCategory(adder.token))).toBe(false)
  })

  test('reads stay open for a role without the menu', async () => {
    const other = await account({ accessMenu: [{ menu: '/home', view: true }] })
    expect(menuDenied(await as(other.token, 'get', '/category/get-category'))).toBe(false)
  })

  test('an action the matrix never offers falls back to any grant on the menu', async () => {
    // /accounting offers only "view"; creating an account needs that view
    const viewer = await account({ accessMenu: [{ menu: '/accounting', view: true }] })
    expect(menuDenied(await as(viewer.token, 'post', '/accounting/accounts').send({}))).toBe(false)
    const none = await account({ accessMenu: [{ menu: '/home', view: true }] })
    expect(menuDenied(await as(none.token, 'post', '/accounting/accounts').send({}))).toBe(true)
  })

  test('cashier flows are excluded (promo apply)', async () => {
    const kasir = await account({ roleType: 'kasir', accessMenu: [{ menu: '/home', view: true }] })
    expect(menuDenied(await as(kasir.token, 'post', '/promo/apply').send({}))).toBe(false)
  })

  test('accounts without any menu and the global super_admin keep their old gates', async () => {
    const legacy = await account({ accessMenu: [] })
    expect(menuDenied(await addCategory(legacy.token))).toBe(false)
    const global = await account({ roleType: 'super_admin' })
    expect(menuDenied(await addCategory(global.token))).toBe(false)
  })

  test('an anonymous write is still 401', async () => {
    expect((await request(app).post('/category/add-new-category').send({})).status).toBe(401)
  })
})

describe('salary is payroll data', () => {
  test('a kasir listing employees gets no salary; an admin does', async () => {
    await account({ roleType: 'user', extra: { monthlySalary: 4500000, dailySalary: 150000 } })
    const kasir = await account({ roleType: 'kasir' })
    const admin = await account({ roleType: 'admin' })
    const listed = async (token) =>
      JSON.stringify((await as(token, 'get', '/employee/get-employee').query({ limit: 100 })).body)
    expect(await listed(kasir.token)).not.toMatch(/monthlySalary|dailySalary/)
    expect(await listed(admin.token)).toMatch(/monthlySalary/)
  })
})

describe('report settings are audited', () => {
  test('saving report settings writes an audit row with before/after', async () => {
    const admin = await account({ roleType: 'super_admin' })
    const res = await as(admin.token, 'put', '/report-config/daily').send({
      config: { accentColor: '#123456' }
    })
    expect(res.status).toBe(200)
    const row = await db.auditLog.findOne({
      where: { entity: 'report_config', userId: admin.user.id },
      order: [['id', 'DESC']]
    })
    expect(row).not.toBeNull()
  })
})
