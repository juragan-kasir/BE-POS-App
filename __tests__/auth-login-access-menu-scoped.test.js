process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

// A super_admin account carrying its OWN accessMenu is menu-scoped
// (accessMenuScoped: true on login) so the client shows only those menus; a
// super_admin that only inherits the Super Admin role's list is not.
// Non-super_admin accounts never carry the flag.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const PASSWORD = 'Rahasia123!'
const createdIds = []
let superRole

const SCOPED_MENU = [
  { menu: '/product-list', view: true, add: true, edit: true, delete: true },
  { menu: '/bom', view: true, add: true, edit: true, delete: true }
]

const createLoginUser = async (overrides) => {
  const user = await db.user.create({
    userName: unique('scoped'),
    email: `${unique('scopedmail')}@test.com`,
    password: PASSWORD,
    userType: 'user',
    status: 'active',
    ...overrides
  })
  createdIds.push(user.id)
  return user
}

const login = (userName) => request(app).post('/auth/login').send({ userName, password: PASSWORD })

beforeAll(async () => {
  superRole = await db.role.create({
    name: unique('Super Admin'),
    roleType: 'super_admin',
    store: null,
    accessMenu: JSON.stringify([{ menu: 'dashboard', read: true }, { menu: 'home', read: true }])
  })
})

afterAll(async () => {
  await db.authorizationContextSession.destroy({ where: { userId: createdIds } })
  await db.user.destroy({ where: { id: createdIds }, force: true })
  await db.role.destroy({ where: { id: superRole.id }, force: true })
})

test('a super_admin with its own accessMenu logs in menu-scoped with that list', async () => {
  const user = await createLoginUser({
    roleType: 'super_admin',
    roleId: superRole.id,
    accessMenu: JSON.stringify(SCOPED_MENU)
  })
  const res = await login(user.userName)
  expect(res.status).toBe(200)
  expect(res.body.user.accessMenuScoped).toBe(true)
  expect(res.body.user.accessMenu).toEqual(SCOPED_MENU)
})

test('a super_admin inheriting the role list is not scoped', async () => {
  const user = await createLoginUser({ roleType: 'super_admin', roleId: superRole.id, accessMenu: null })
  const res = await login(user.userName)
  expect(res.status).toBe(200)
  expect(res.body.user.accessMenuScoped).toBe(false)
  expect(res.body.user.accessMenu.map((m) => m.menu)).toEqual(['dashboard', 'home'])
})

test('an empty own accessMenu does not scope a super_admin', async () => {
  const user = await createLoginUser({ roleType: 'super_admin', roleId: superRole.id, accessMenu: '[]' })
  const res = await login(user.userName)
  expect(res.body.user.accessMenuScoped).toBe(false)
})

test('a non-super_admin is never flagged, even with its own accessMenu', async () => {
  const user = await createLoginUser({ roleType: 'admin', accessMenu: JSON.stringify(SCOPED_MENU) })
  const res = await login(user.userName)
  expect(res.status).toBe(200)
  expect(res.body.user.accessMenuScoped).toBe(false)
})
