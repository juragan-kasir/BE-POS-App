process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

// E2E 2026-11-11 (F-17): a kasir whose role has no report menu was refused
// the report pages in the UI but could still GET /report/data/daily, which
// carries HPP and profit. Report data and exports now follow the menu of
// the screens that show them; accounts without a menu keep their access.

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
let seq = 0
const unique = (p) => `${p}_${Date.now()}_${++seq}`

let location
const users = []

const account = async ({ roleType = 'admin', accessMenu = [] } = {}) => {
  const user = await db.user.create({
    userName: unique('rmg'),
    email: `${unique('rmg')}@test.com`,
    roleType,
    userType: roleType === 'kasir' ? 'user' : 'admin',
    store: location.id,
    status: 'active',
    accessMenu
  })
  users.push(user.id)
  return signSessionToken(
    { id: user.id, userName: user.userName, roleType, store: user.store },
    JWT_SECRET
  )
}

const get = (token, path) =>
  request(app).get(path).set('Authorization', `Bearer ${token}`).query({ store: location.id })
const menuDenied = (res) => res.status === 403 && res.body?.code === 'MENU_ACTION_DENIED'
const cashierOnly = [{ menu: '/home', view: true, add: true }]

beforeAll(async () => {
  location = await db.location.create({ name: unique('RMG_STORE'), status: 'active' })
})

afterAll(async () => {
  await db.auditLog.destroy({ where: { userId: users }, force: true, __auditMaintenance: true })
  await db.authorizationContextSession.destroy({ where: { userId: users } })
  await db.user.destroy({ where: { id: users }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

describe('report data follows the role menu', () => {
  test.each(['daily', 'sales', 'cashFlow', 'profitPerProduct', 'kasirPerformance'])(
    'a kasir without report menus is refused %s',
    async (key) => {
      const token = await account({ roleType: 'kasir', accessMenu: cashierOnly })
      expect(menuDenied(await get(token, `/report/data/${key}`))).toBe(true)
      expect(menuDenied(await get(token, `/report/export/${key}`))).toBe(true)
    }
  )

  test('a role with the daily report menu reads it', async () => {
    const token = await account({ accessMenu: [{ menu: '/report/daily', view: true }] })
    const res = await get(token, '/report/data/daily')
    expect(menuDenied(res)).toBe(false)
    expect(res.status).toBe(200)
  })

  test('Advanced Reporting grants the keys it shows', async () => {
    const token = await account({ accessMenu: [{ menu: '/advanced-reporting', view: true }] })
    expect(menuDenied(await get(token, '/report/data/kasirPerformance'))).toBe(false)
  })

  test('an account without a menu keeps its access', async () => {
    const token = await account({ accessMenu: [] })
    expect(menuDenied(await get(token, '/report/data/daily'))).toBe(false)
  })
})
