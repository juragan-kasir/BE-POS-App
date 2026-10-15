process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// "Gunakan di Kasir & BISA" — PUT /tax-config/apply/:id makes one PPN row the
// applied rate of its scope (it becomes active, the other active PPN rows of
// the same scope become inactive), and checkout (counter + QR) then charges
// exactly that rate. Same access rules as editing a tax config.
let storeA
let storeB
let adminAToken
let superToken

const makeTax = (overrides) =>
  db.taxConfig.create({ name: 'APPLY_ROW', rate: 11, type: 'ppn', status: 'active', store: null, ...overrides })
const apply = (id, token) => request(app).put(`/tax-config/apply/${id}`).set('Authorization', `Bearer ${token}`)
const qrRate = async (store) =>
  (await request(app).get(`/order/customer-tax-rate?store=${store}&channel=qr`)).body.data.rate
const statusOf = async (row) => (await db.taxConfig.findByPk(row.id)).status

beforeAll(async () => {
  storeA = await db.location.create({ name: 'APPLY_STORE_A', status: 'active' })
  storeB = await db.location.create({ name: 'APPLY_STORE_B', status: 'active' })
  await db.user.create({
    id: 9951, userName: 'apply_admin_a', email: 'apply-9951@test.com', roleType: 'admin',
    userType: 'admin', store: storeA.id, status: 'active', fullName: 'apply_admin_a'
  })
  await db.user.create({
    id: 9953, userName: 'apply_super', email: 'apply-9953@test.com', roleType: 'super_admin',
    userType: 'admin', store: null, status: 'active', fullName: 'apply_super'
  })
  adminAToken = await signSessionToken({ id: 9951, userName: 'apply_admin_a', roleType: 'admin', store: storeA.id }, JWT_SECRET)
  superToken = await signSessionToken({ id: 9953, userName: 'apply_super', roleType: 'super_admin', store: null }, JWT_SECRET)
})

beforeEach(async () => {
  await db.taxConfig.destroy({ where: {}, force: true })
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: {}, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: [9951, 9953] } })
  await db.user.destroy({ where: { id: [9951, 9953] }, force: true })
  await db.location.destroy({ where: { id: [storeA.id, storeB.id] }, force: true })
})

test('duplicate global PPN rows: checkout already charges one rate (11%, never 22%)', async () => {
  await makeTax({ name: 'PPN 11%' })
  await makeTax({ name: 'PPN 11% (dup)' })
  expect(await qrRate(storeA.id)).toBe(11)
})

test('a global super_admin applies a global row: the other global PPN rows go inactive', async () => {
  const seeded = await makeTax({ name: 'PPN 11%' })
  const dup = await makeTax({ name: 'PPN 11% (dup)' })
  const twelve = await makeTax({ name: 'PPN 12%', rate: 12, status: 'inactive' })
  const outletRow = await makeTax({ name: 'Outlet B PPN', rate: 10, store: storeB.id })

  const res = await apply(twelve.id, superToken)
  expect(res.status).toBe(200)
  expect(res.body.data.deactivated).toBe(2)
  expect(await statusOf(twelve)).toBe('active')
  expect(await statusOf(seeded)).toBe('inactive')
  expect(await statusOf(dup)).toBe('inactive')
  // another scope is untouched
  expect(await statusOf(outletRow)).toBe('active')
  expect(await qrRate(storeA.id)).toBe(12)
  expect(await qrRate(storeB.id)).toBe(10)
})

test('an outlet admin applies its own outlet row: it overrides global, global untouched', async () => {
  const global = await makeTax({ name: 'PPN 11%' })
  const own = await makeTax({ name: 'Outlet A PPN 0%', rate: 0, store: storeA.id, status: 'inactive' })
  const res = await apply(own.id, adminAToken)
  expect(res.status).toBe(200)
  expect(await statusOf(global)).toBe('active')
  expect(await qrRate(storeA.id)).toBe(0)
  expect(await qrRate(storeB.id)).toBe(11)
})

test('an outlet admin cannot apply a global row', async () => {
  const global = await makeTax({ name: 'PPN 11%', status: 'inactive' })
  const res = await apply(global.id, adminAToken)
  expect(res.status).toBe(403)
  expect(await statusOf(global)).toBe('inactive')
})

test('an outlet admin cannot apply another outlet row', async () => {
  const other = await makeTax({ name: 'Outlet B PPN', store: storeB.id, status: 'inactive' })
  const res = await apply(other.id, adminAToken)
  expect(res.status).toBe(404)
  expect(await statusOf(other)).toBe('inactive')
})

test('only PPN rows can be applied', async () => {
  const sc = await makeTax({ name: 'Service', type: 'service_charge', rate: 5 })
  const res = await apply(sc.id, superToken)
  expect(res.status).toBe(400)
  expect(res.body.code).toBe('TAX_APPLY_PPN_ONLY')
})
