process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

// FG-SEC-01 wave 3: the remaining back-office route files follow the Role
// Management checkboxes for their writes. Cashier/floor flows (queue,
// waiter requests, counter returns) and accounts without a menu are untouched.

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
let seq = 0
const unique = (p) => `${p}_${Date.now()}_${++seq}`

let location
const users = []

const account = async ({ roleType = 'admin', accessMenu = [] } = {}) => {
  const user = await db.user.create({
    userName: unique('mw3'),
    email: `${unique('mw3')}@test.com`,
    roleType,
    userType: roleType === 'kasir' || roleType === 'user' ? 'user' : 'admin',
    store: location.id,
    status: 'active',
    accessMenu
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
const homeOnly = [{ menu: '/home', view: true, add: true }]

beforeAll(async () => {
  location = await db.location.create({ name: unique('MW3_STORE'), status: 'active' })
})

afterAll(async () => {
  // A gate that lets the call through reaches the controller: the register
  // open (and anything else that validated) wrote real rows for this store.
  await db.cashRegister.destroy({ where: { store: location.id }, force: true })
  await db.auditLog.destroy({ where: { userId: users }, force: true, __auditMaintenance: true })
  await db.authorizationContextSession.destroy({ where: { userId: users } })
  await db.user.destroy({ where: { id: users }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

describe('back-office writes follow the role menu', () => {
  test.each([
    ['post', '/department/add-new-department', '/department-list'],
    ['post', '/position/add-new-position', '/position-list'],
    ['delete', '/employee/delete-employee/999999', '/employee-list'],
    ['post', '/member-tier/add', '/member-tier'],
    ['delete', '/member/delete-member/999999', '/member-list'],
    ['post', '/shift/add-new-shift', '/shift-list'],
    ['post', '/shift-template/add-new-shift-template', '/shift-template-list'],
    ['post', '/business-trip/create', '/business-trip'],
    ['put', '/invoice/setting', '/invoice-page'],
    ['post', '/accounts-receivable/create', '/accounts-receivable'],
    ['post', '/cash-register/open', '/cash-register/current'],
    ['patch', '/sales-return/reject/999999', '/sales-return'],
    ['post', '/stock-history/auto-generate-po', '/low-stock']
  ])('%s %s needs %s', async (method, path, menu) => {
    const without = await account({ accessMenu: homeOnly })
    expect(menuDenied(await as(without.token, method, path).send({}))).toBe(true)
    const withMenu = await account({
      accessMenu: [{ menu, view: true, add: true, edit: true, delete: true }]
    })
    expect(menuDenied(await as(withMenu.token, method, path).send({}))).toBe(false)
  })

  test('legacy role keys (stripped form) still grant', async () => {
    const legacy = await account({ accessMenu: [{ menu: 'department', create: true, read: true }] })
    expect(menuDenied(await as(legacy.token, 'post', '/department/add-new-department').send({}))).toBe(false)
  })
})

describe('pos.js gates each back-office section with its own menu', () => {
  test.each([
    ['post', '/pos/adjust', '/stock-adjustment'],
    ['post', '/pos/transfer', '/stock-transfer'],
    ['put', '/pos/product/update-price-by-store', '/price-list-template'],
    ['post', '/pos/purchase-order/999999/return', '/purchase-return']
  ])('%s %s needs %s', async (method, path, menu) => {
    const without = await account({ accessMenu: homeOnly })
    expect(menuDenied(await as(without.token, method, path).send({}))).toBe(true)
    const withMenu = await account({ accessMenu: [{ menu, view: true, add: true, edit: true }] })
    expect(menuDenied(await as(withMenu.token, method, path).send({}))).toBe(false)
  })

  test('cashier paths in pos.js are not menu-gated', async () => {
    const kasir = await account({ roleType: 'kasir', accessMenu: homeOnly })
    expect(menuDenied(await as(kasir.token, 'post', '/pos/order/999999/return').send({}))).toBe(false)
    expect(menuDenied(await as(kasir.token, 'put', '/pos/tables/999999/release').send({}))).toBe(false)
  })
})

describe('cashier floor flows and menu-less accounts are untouched', () => {
  test('a kasir with the cashier menu can still write the queue and waiter requests', async () => {
    const kasir = await account({ roleType: 'kasir', accessMenu: homeOnly })
    expect(menuDenied(await as(kasir.token, 'post', '/queue').send({}))).toBe(false)
    expect(menuDenied(await as(kasir.token, 'put', '/waiter-request/999999/status').send({}))).toBe(false)
  })

  test('an admin without any menu keeps its existing gates', async () => {
    const legacy = await account({ accessMenu: [] })
    expect(menuDenied(await as(legacy.token, 'post', '/department/add-new-department').send({}))).toBe(false)
  })

  test('reads stay open', async () => {
    const other = await account({ accessMenu: homeOnly })
    expect(menuDenied(await as(other.token, 'get', '/department/get-department'))).toBe(false)
  })
})
