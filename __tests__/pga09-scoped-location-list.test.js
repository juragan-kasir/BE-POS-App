'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-09 (product-grade audit 2026-11-02): the signed-in store pickers used
// the unauthenticated GET /location/get-location-public, which lists every
// outlet of every merchant. Owners saw a competitor's outlets and the
// dashboard preselected one. GET /location/get-location-mine returns the same
// fields, limited to the outlets the caller may work in.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const P = 'pga09'
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const created = { users: [], tenants: [], stores: [] }
let homeA
let homeB
let homeArchived
let foreign
let ownerToken
let kasirToken
let vendorToken

beforeAll(async () => {
  const home = await db.tenant.create({ code: `${P}-home-${uniq()}`, name: 'PGA09 Home' })
  const other = await db.tenant.create({ code: `${P}-other-${uniq()}`, name: 'PGA09 Other' })
  created.tenants.push(home.id, other.id)
  homeA = await db.location.create({ name: `PGA09_A_${uniq()}`, status: 'active', tenantId: home.id })
  homeB = await db.location.create({ name: `PGA09_B_${uniq()}`, status: 'active', tenantId: home.id })
  homeArchived = await db.location.create({ name: `PGA09_X_${uniq()}`, status: 'inactive', tenantId: home.id })
  foreign = await db.location.create({ name: `PGA09_F_${uniq()}`, status: 'active', tenantId: other.id })
  created.stores.push(homeA.id, homeB.id, homeArchived.id, foreign.id)

  const owner = await db.user.create({
    userName: `${P}_owner_${uniq()}`,
    email: `${P}_owner_${uniq()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: homeA.id,
    status: 'active'
  })
  const kasir = await db.user.create({
    userName: `${P}_kasir_${uniq()}`,
    email: `${P}_kasir_${uniq()}@test.com`,
    roleType: 'user',
    userType: 'user',
    store: homeB.id,
    status: 'active'
  })
  const vendor = await db.user.create({
    userName: `${P}_vendor_${uniq()}`,
    email: `${P}_vendor_${uniq()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active'
  })
  created.users.push(owner.id, kasir.id, vendor.id)
  await db.tenantMembership.create({ userId: owner.id, tenantId: home.id, role: 'tenant_admin', status: 'ACTIVE' })

  ownerToken = await signSessionToken(
    { id: owner.id, userName: owner.userName, roleType: 'super_admin', store: homeA.id },
    JWT_SECRET
  )
  kasirToken = await signSessionToken(
    { id: kasir.id, userName: kasir.userName, roleType: 'user', store: homeB.id },
    JWT_SECRET
  )
  vendorToken = await signSessionToken(
    { id: vendor.id, userName: vendor.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.tenantMembership.destroy({ where: { userId: created.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
  await db.tenant.destroy({ where: { id: created.tenants }, force: true })
})

const mine = (token, qs = '') => {
  const req = request(app).get(`/location/get-location-mine${qs}`)
  return token ? req.set('Authorization', `Bearer ${token}`) : req
}
const ids = (res) => res.body.data.map((l) => Number(l.id))

describe('PGA-09: signed-in store list is scoped to the caller', () => {
  test('a multi-outlet owner gets its own active outlets and never another tenant', async () => {
    const res = await mine(ownerToken)
    expect(res.status).toBe(200)
    expect(ids(res)).toEqual(expect.arrayContaining([homeA.id, homeB.id]))
    expect(ids(res)).not.toContain(foreign.id)
    expect(ids(res)).not.toContain(homeArchived.id)
    // Same public shape the pickers already read.
    const row = res.body.data.find((l) => Number(l.id) === homeA.id)
    expect(row.name).toBe(homeA.name)
    expect(row).toHaveProperty('isOpen')
    expect(row).not.toHaveProperty('openingHours')
    expect(row).not.toHaveProperty('timezone')
  })

  test('status=all adds the owner\'s archived outlet, still nothing foreign', async () => {
    const res = await mine(ownerToken, '?status=all')
    expect(res.status).toBe(200)
    expect(ids(res)).toEqual(expect.arrayContaining([homeA.id, homeB.id, homeArchived.id]))
    expect(ids(res)).not.toContain(foreign.id)
  })

  test('a cashier sees only its own outlet', async () => {
    const res = await mine(kasirToken)
    expect(res.status).toBe(200)
    expect(ids(res)).toEqual([homeB.id])
  })

  test('the vendor super admin still sees every outlet', async () => {
    const res = await mine(vendorToken)
    expect(res.status).toBe(200)
    expect(ids(res)).toEqual(expect.arrayContaining([homeA.id, homeB.id, foreign.id]))
  })

  test('it requires a session', async () => {
    const res = await mine(null)
    expect(res.status).toBe(401)
  })
})
