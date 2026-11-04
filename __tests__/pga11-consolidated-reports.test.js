'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-11 (product-grade audit 2026-11-02): a multi-outlet owner's
// consolidated sales summary (no ?store) showed only the first outlet —
// validateStoreAccess puts the tenant roster in req.storeIds and the first
// outlet in req.storeId, and the reports read the scalar (34.2 M shown vs a
// 106.1 M tenant ledger). Reports now aggregate the whole outlet set.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const P = 'pga11'
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const created = { users: [], tenants: [], stores: [], orders: [] }
let homeA
let homeB
let foreign
let ownerToken

beforeAll(async () => {
  const home = await db.tenant.create({ code: `${P}-home-${uniq()}`, name: 'PGA11 Home' })
  const other = await db.tenant.create({ code: `${P}-other-${uniq()}`, name: 'PGA11 Other' })
  created.tenants.push(home.id, other.id)
  homeA = await db.location.create({ name: `PGA11_A_${uniq()}`, status: 'active', tenantId: home.id })
  homeB = await db.location.create({ name: `PGA11_B_${uniq()}`, status: 'active', tenantId: home.id })
  foreign = await db.location.create({ name: `PGA11_F_${uniq()}`, status: 'active', tenantId: other.id })
  created.stores.push(homeA.id, homeB.id, foreign.id)

  for (const [store, totalPrice, label] of [
    [homeA.id, 15000, 'A'],
    [homeB.id, 25000, 'B'],
    [homeB.id, 5000, 'B2'],
    [foreign.id, 40000, 'F']
  ]) {
    const order = await db.order.create({
      orderNumber: `${P}-${label}-${uniq()}`,
      store,
      status: 'paid',
      paymentStatus: 'paid',
      subTotal: totalPrice,
      totalPrice,
      totalQuantity: 1,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    created.orders.push(order.id)
  }

  const owner = await db.user.create({
    userName: `${P}_${uniq()}`,
    email: `${P}_${uniq()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: homeA.id,
    status: 'active'
  })
  created.users.push(owner.id)
  await db.tenantMembership.create({ userId: owner.id, tenantId: home.id, role: 'tenant_admin', status: 'ACTIVE' })
  ownerToken = await signSessionToken(
    { id: owner.id, userName: owner.userName, roleType: 'super_admin', store: homeA.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.auditLog.destroy({ where: { userId: created.users }, force: true }).catch(() => {})
  await db.order.destroy({ where: { id: created.orders }, force: true })
  await db.tenantMembership.destroy({ where: { userId: created.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
  await db.tenant.destroy({ where: { id: created.tenants }, force: true })
})

const get = (path) => request(app).get(path).set('Authorization', `Bearer ${ownerToken}`)

describe('PGA-11 — consolidated reports cover every outlet of the owner', () => {
  test('sales summary without ?store = all own outlets, never the other tenant', async () => {
    const res = await get('/report/sales-summary?filter=today')
    expect(res.status).toBe(200)
    const data = res.body.data
    expect(data.totalSales).toBe(45000)
    expect(data.totalOrders).toBe(3)
    expect(data.totalStores).toBe(2)
    expect(data.stores.map((s) => s.id).sort()).toEqual([homeA.id, homeB.id].sort())
    const byId = Object.fromEntries(data.stores.map((s) => [s.id, s.sales]))
    expect(byId[homeA.id]).toBe(15000)
    expect(byId[homeB.id]).toBe(30000)
  })

  test('?store narrows the summary to that outlet', async () => {
    const res = await get(`/report/sales-summary?filter=today&store=${homeB.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totalSales).toBe(30000)
    expect(res.body.data.stores.map((s) => s.id)).toEqual([homeB.id])
  })

  test('the "sales" report table (/report/data/sales) lists both own outlets', async () => {
    const res = await get('/report/data/sales?filter=today')
    expect(res.status).toBe(200)
    const body = JSON.stringify(res.body)
    expect(body).toContain(homeA.name)
    expect(body).toContain(homeB.name)
    expect(body).not.toContain(foreign.name)
  })

  test('a foreign outlet is still refused', async () => {
    expect((await get(`/report/sales-summary?filter=today&store=${foreign.id}`)).status).toBe(403)
  })
})
