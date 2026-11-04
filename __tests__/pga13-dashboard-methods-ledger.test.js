'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-13 (product-grade audit 2026-11-02): the dashboard's per-method
// figures used the order-level method. A split bill showed only one method
// (its E-wallet part vanished), refunds were ignored, and cash appeared as
// two methods ("CASH"/"cash", "Cash"/"Tunai"). They now come from the
// payment ledger, net of refund rows, one row per canonical method.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const created = { users: [], tenants: [], stores: [], orders: [] }
let store
let adminToken
let ownerToken

const order = async (fields, payments) => {
  const o = await db.order.create({
    orderNumber: `PGA13-${uniq()}`,
    store: store.id,
    status: 'paid',
    paymentStatus: 'paid',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields
  })
  created.orders.push(o.id)
  for (const p of payments) {
    await db.transaction.create({ order: o.id, ...p })
  }
  return o
}

beforeAll(async () => {
  const tenant = await db.tenant.create({ code: `pga13-${uniq()}`, name: 'PGA13' })
  created.tenants.push(tenant.id)
  store = await db.location.create({ name: `PGA13_${uniq()}`, status: 'active', tenantId: tenant.id })
  created.stores.push(store.id)

  // Split bill: order-level method says cash, the ledger has cash + e-wallet.
  await order({ totalPrice: 100000, paymentMethod: 'cash' }, [
    { typePayment: 'CASH', amount: 60000, paymentMethodName: 'Cash' },
    { typePayment: 'E_WALLET', amount: 40000, paymentMethodName: 'GoPay' }
  ])
  // Cash with the other label the clients send, then partly refunded.
  await order({ totalPrice: 30000, paymentMethod: 'CASH', paymentMethodName: 'Tunai' }, [
    { typePayment: 'CASH', amount: 30000, paymentMethodName: 'Tunai' },
    { typePayment: 'CASH', amount: -10000 }
  ])
  // Not a completed sale: never counted.
  await order({ totalPrice: 50000, paymentMethod: 'CASH', status: 'cancelled', paymentStatus: 'unpaid' }, [])

  const admin = await db.user.create({
    userName: `pga13_admin_${uniq()}`,
    email: `pga13_admin_${uniq()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  const owner = await db.user.create({
    userName: `pga13_owner_${uniq()}`,
    email: `pga13_owner_${uniq()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  created.users.push(admin.id, owner.id)
  await db.tenantMembership.create({ userId: owner.id, tenantId: tenant.id, role: 'tenant_admin', status: 'ACTIVE' })
  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  ownerToken = await signSessionToken(
    { id: owner.id, userName: owner.userName, roleType: 'super_admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.transaction.destroy({ where: { order: created.orders }, force: true })
  await db.order.destroy({ where: { id: created.orders }, force: true })
  await db.tenantMembership.destroy({ where: { userId: created.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
  await db.tenant.destroy({ where: { id: created.tenants }, force: true })
})

const range = () => {
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10)
  return { startDate: day(-1), endDate: day(1) }
}

describe('PGA-13: per-method dashboard figures = payment ledger', () => {
  test('store dashboard: split parts, refunds and both cash labels', async () => {
    const res = await request(app)
      .get('/pos/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .query(range())
    expect(res.status).toBe(200)
    const rows = res.body.data.paymentMethods
    const cash = rows.filter((r) => r.method === 'CASH')
    // One cash row, net of the refund: 60.000 + 30.000 − 10.000.
    expect(cash).toHaveLength(1)
    expect(cash[0]).toEqual(expect.objectContaining({ name: null, sales: 80000 }))
    // The e-wallet part of the split bill is reported.
    expect(rows.find((r) => r.method === 'E_WALLET')).toEqual(
      expect.objectContaining({ name: 'GoPay', sales: 40000 })
    )
    // Σ per-method = Σ ledger.
    expect(rows.reduce((s, r) => s + r.sales, 0)).toBe(120000)
    // No legacy lowercase method key survives.
    expect(rows.map((r) => r.method)).not.toContain('cash')
  })

  test('super-admin dashboard method detail has one cash row', async () => {
    const res = await request(app)
      .get('/pos/dashboard/super-admin')
      .set('Authorization', `Bearer ${ownerToken}`)
      .query({ ...range(), store: store.id })
    expect(res.status).toBe(200)
    const { byMethod, byType } = res.body.data.paymentBreakdown
    const cash = byMethod.filter((m) => m.method === 'CASH')
    expect(cash).toHaveLength(1)
    expect(cash[0]).toEqual(expect.objectContaining({ name: null, bucket: 'CASH', amount: 80000 }))
    expect(byType.find((b) => b.type === 'CASH').amount).toBe(80000)
  })
})
