'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// A store-bound super_admin with an ACTIVE tenant_admin membership (a
// client's own admin, e.g. owner_t3) must only ever see its active tenant.
// Regression for the 2026-11-01 audit: omitting ?store= let dashboard/report/
// order endpoints fall through to platform-wide data because
// validateStoreAccess returned req.storeId = null for tenant-wide actors.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const P = 'tads'
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const created = { users: [], tenants: [], stores: [], orders: [] }
let homeTenant
let foreignTenant
let homeStoreA
let homeStoreB
let foreignStore
let ownerToken

beforeAll(async () => {
  homeTenant = await db.tenant.create({ code: `${P}-home-${uniq()}`, name: 'TADS Home' })
  foreignTenant = await db.tenant.create({ code: `${P}-foreign-${uniq()}`, name: 'TADS Foreign' })
  created.tenants.push(homeTenant.id, foreignTenant.id)

  homeStoreA = await db.location.create({ name: `TADS_A_${uniq()}`, status: 'active', tenantId: homeTenant.id })
  homeStoreB = await db.location.create({ name: `TADS_B_${uniq()}`, status: 'active', tenantId: homeTenant.id })
  foreignStore = await db.location.create({ name: `TADS_F_${uniq()}`, status: 'active', tenantId: foreignTenant.id })
  created.stores.push(homeStoreA.id, homeStoreB.id, foreignStore.id)

  const owner = await db.user.create({
    userName: `${P}_${uniq()}`,
    email: `${P}_${uniq()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: homeStoreA.id,
    status: 'active'
  })
  created.users.push(owner.id)
  await db.tenantMembership.create({
    userId: owner.id,
    tenantId: homeTenant.id,
    role: 'tenant_admin',
    status: 'ACTIVE'
  })

  for (const [store, totalPrice, label] of [
    [homeStoreA.id, 15000, 'A'],
    [homeStoreB.id, 25000, 'B'],
    [foreignStore.id, 40000, 'F']
  ]) {
    const order = await db.order.create({
      orderNumber: `${P}-${label}-${uniq()}`,
      store,
      status: 'paid',
      paymentStatus: 'paid',
      totalPrice,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    created.orders.push(order.id)
  }

  ownerToken = await signSessionToken(
    { id: owner.id, userName: owner.userName, roleType: 'super_admin', store: owner.store },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.order.destroy({ where: { id: created.orders }, force: true })
  await db.tenantMembership.destroy({ where: { userId: created.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
  await db.tenant.destroy({ where: { id: created.tenants }, force: true })
})

const get = (path) => request(app).get(path).set('Authorization', `Bearer ${ownerToken}`)

describe('store-bound super_admin with tenant_admin membership', () => {
  test('dashboard aggregates only its tenant stores, never a foreign tenant', async () => {
    const res = await get('/pos/dashboard/super-admin')
    expect(res.status).toBe(200)
    const data = res.body.data
    expect(data.stores.map((s) => s.id).sort()).toEqual([homeStoreA.id, homeStoreB.id].sort())
    expect(data.meta.storeCount).toBe(2)
    expect(data.summary.revenue).toBe(40000)
  })

  test('order list omits foreign-tenant orders and still includes all own stores', async () => {
    const res = await get('/order/get-orders?limit=100')
    expect(res.status).toBe(200)
    const stores = res.body.data.map((o) => Number(o.store))
    expect(new Set(stores)).toEqual(new Set([homeStoreA.id, homeStoreB.id]))
    expect(res.body.pagination.total).toBe(2)
  })

  test('an explicitly requested foreign store is refused', async () => {
    expect((await get(`/pos/dashboard/super-admin?store=${foreignStore.id}`)).status).toBe(403)
    expect((await get(`/order/get-orders?store=${foreignStore.id}`)).status).toBe(403)
  })
})
