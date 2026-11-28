process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'secret-key-user'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY
const RUN = Date.now()

let tenant, store, admin, cashier, owner, adminToken, cashierToken, ownerToken

beforeAll(async () => {
  tenant = await db.tenant.create({ code: `bkr_ctx_${RUN}`, name: `BKR CTX ${RUN}`, status: 'active' })
  store = await db.location.create({ name: `BKR_CTX_STORE_${RUN}`, status: 'active', businessType: 'bakery', tenantId: tenant.id })
  admin = await db.user.create({ userName: `bkr_ctx_admin_${RUN}`, email: `bkr_ctx_admin_${RUN}@t.test`, roleType: 'admin', userType: 'admin', store: store.id, status: 'active', fullName: 'Bakery Admin' })
  cashier = await db.user.create({ userName: `bkr_ctx_kasir_${RUN}`, email: `bkr_ctx_kasir_${RUN}@t.test`, roleType: 'admin', userType: 'admin', store: store.id, status: 'active', fullName: 'Bakery Kasir' })
  owner = await db.user.create({ userName: `bkr_ctx_owner_${RUN}`, email: `bkr_ctx_owner_${RUN}@t.test`, roleType: 'admin', userType: 'admin', store: null, status: 'active', fullName: 'Bakery Owner' })
  await db.tenantMembership.create({ userId: cashier.id, tenantId: tenant.id, role: 'cashier', status: 'ACTIVE' })
  await db.tenantMembership.create({ userId: owner.id, tenantId: tenant.id, role: 'tenant_admin', status: 'ACTIVE' })
  adminToken = await signSessionToken({ id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id }, JWT_SECRET)
  cashierToken = await signSessionToken({ id: cashier.id, userName: cashier.userName, roleType: 'admin', store: store.id }, JWT_SECRET)
  ownerToken = await signSessionToken({ id: owner.id, userName: owner.userName, roleType: 'admin', store: null }, JWT_SECRET)
})

afterAll(async () => {
  try { await db.tenantMembership.destroy({ where: { userId: [admin.id, cashier.id, owner.id] }, force: true }) } catch {}
  try { await db.user.destroy({ where: { id: [admin.id, cashier.id, owner.id] }, force: true }) } catch {}
  try { await db.location.destroy({ where: { id: store.id }, force: true }) } catch {}
  try { await db.tenant.destroy({ where: { id: tenant.id }, force: true }) } catch {}
})

describe('GET /bakery/context', () => {
  test('returns the raw AuthContext shape for the active store tenant', async () => {
    const res = await request(app).get('/bakery/context').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.tenant).toEqual(expect.objectContaining({ id: String(tenant.id), name: tenant.name }))
    expect(res.body.tenant.settings).toEqual(expect.objectContaining({ businessType: 'bakery', leadTimeMinutes: 60 }))
    expect(res.body.user).toEqual({ id: String(admin.id), name: 'Bakery Admin', email: admin.email })
    expect(res.body.canonicalRole).toBe('admin')
    expect(res.body.permissions).toEqual(expect.arrayContaining(['bakery.order.manage', 'bakery.settings.manage']))
    expect(res.body.stores).toEqual([expect.objectContaining({ id: String(store.id), name: store.name })])
    expect(res.body.onboardingRequired).toBe(false)
    expect(res.body.staffUserId).toBeNull()
  })

  test('uses the ACTIVE membership role over the legacy roleType', async () => {
    const res = await request(app).get('/bakery/context').set('Authorization', `Bearer ${cashierToken}`)
    expect(res.status).toBe(200)
    expect(res.body.canonicalRole).toBe('kasir')
    expect(res.body.permissions).toContain('bakery.order.manage')
    expect(res.body.permissions).not.toContain('bakery.settings.manage')
  })

  test('a tenant-wide owner without an assigned store sees the tenant outlets', async () => {
    const res = await request(app).get('/bakery/context').set('Authorization', `Bearer ${ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.canonicalRole).toBe('owner')
    expect(res.body.tenant.id).toBe(String(tenant.id))
    expect(res.body.stores).toEqual([expect.objectContaining({ id: String(store.id) })])
    expect(res.body.onboardingRequired).toBe(false)
  })
})
