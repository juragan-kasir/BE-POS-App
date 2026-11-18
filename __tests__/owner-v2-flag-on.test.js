'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'
process.env.AUTHZ_OWNER_V2 = 'true'

// Owner → tenant → outlet hierarchy with AUTHZ_OWNER_V2 ON (BE audit
// 2026-11-18, FIXING-PLAN W2-b). Covers the audit findings that the 11-16 SDD
// shipped: P0-1 (an owner administered every tenant), P0-2 (an owner could
// not create an outlet), P1-1/P1-2 (onboarding for vendors / legacy staff),
// K1 (legacy aliases keep their baseline) and the ownership service.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { resolveAuthorizationContext, can, ROLE_BASELINE_PERMISSIONS } = require('../utils/authContext')
const {
  createTenantWithOwner,
  assertOwnerConsistency,
  transferTenantOwnership
} = require('../api/service/tenantOwnershipService')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
const uniq = () => `${RUN}${Math.floor(Math.random() * 1e6).toString(36)}`
const created = { users: [], tenants: [], stores: [] }

const mkUser = async (attrs = {}) => {
  const u = await db.user.create({
    userName: `ov2_${uniq()}`,
    email: `ov2_${uniq()}@test.com`,
    status: 'active',
    roleType: 'user',
    userType: 'admin',
    ...attrs
  })
  created.users.push(u.id)
  return u
}
const mkTenant = async (extra = {}) => {
  const t = await db.tenant.create({ code: `ov2-${uniq()}`, name: `OV2 ${uniq()}`, status: 'active', ...extra })
  created.tenants.push(t.id)
  return t
}
const mkStore = async (tenantId) => {
  const s = await db.location.create({ name: `OV2_S_${uniq()}`, status: 'active', tenantId })
  created.stores.push(s.id)
  return s
}
const member = (user, tenant, role, status = 'ACTIVE') =>
  db.tenantMembership.create({ userId: user.id, tenantId: tenant.id, role, status })
const tokenFor = (user) =>
  signSessionToken({ id: user.id, userName: user.userName, roleType: user.roleType, store: user.store ?? undefined }, JWT_SECRET)
const as = (token, method, path) => request(app)[method](path).set('Authorization', `Bearer ${token}`)

const f = {}

beforeAll(async () => {
  f.tenantA = await mkTenant({ businessType: 'laundry' })
  f.tenantB = await mkTenant()
  f.storeA1 = await mkStore(f.tenantA.id)
  f.storeA2 = await mkStore(f.tenantA.id)
  f.storeB1 = await mkStore(f.tenantB.id)

  f.ownerA = await mkUser()
  await f.tenantA.update({ ownerId: f.ownerA.id })
  await member(f.ownerA, f.tenantA, 'owner')

  f.adminA = await mkUser({ roleType: 'admin' })
  await member(f.adminA, f.tenantA, 'admin')
  await db.storeAssignment.create({ userId: f.adminA.id, tenantId: f.tenantA.id, storeId: f.storeA1.id })

  f.kasirA = await mkUser({ roleType: 'kasir', store: f.storeA1.id })
  await member(f.kasirA, f.tenantA, 'kasir')
  await db.storeAssignment.create({ userId: f.kasirA.id, tenantId: f.tenantA.id, storeId: f.storeA1.id })

  f.legacyAdmin = await mkUser({ roleType: 'admin' })
  await member(f.legacyAdmin, f.tenantA, 'tenant_admin')

  f.legacyKasir = await mkUser({ roleType: 'kasir', store: f.storeA1.id }) // no membership
  f.fresh = await mkUser()
  f.vendor = await mkUser()
  await db.platformAdmin.create({ userId: f.vendor.id, status: 'ACTIVE' })

  // Existing client owner shape (store-bound super_admin + tenant_admin),
  // e.g. bakso_admin: must keep creating outlets through the legacy gate.
  f.tenantC = await mkTenant()
  f.storeC1 = await mkStore(f.tenantC.id)
  f.bakso = await mkUser({ roleType: 'super_admin', userType: 'super_admin', store: f.storeC1.id })
  await member(f.bakso, f.tenantC, 'tenant_admin')

  for (const k of ['ownerA', 'adminA', 'kasirA', 'legacyKasir', 'fresh', 'vendor', 'bakso', 'legacyAdmin']) {
    f[`${k}Token`] = await tokenFor(f[k])
  }
})

afterAll(async () => {
  const own = await db.location.findAll({ where: { tenantId: created.tenants }, attributes: ['id'], paranoid: false })
  const storeIds = [...new Set([...created.stores, ...own.map((l) => l.id)])]
  const ownedTenants = await db.tenant.findAll({ where: { ownerId: created.users }, attributes: ['id'], paranoid: false })
  const tenantIds = [...new Set([...created.tenants, ...ownedTenants.map((t) => t.id)])]
  await db.platformAdmin.destroy({ where: { userId: created.users }, force: true })
  await db.storeAssignment.destroy({ where: { userId: created.users } })
  await db.tenantMembership.destroy({ where: { userId: created.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.auditLog.destroy({ where: { entity: ['tenant', 'location', 'membership'], entityId: [...tenantIds, ...storeIds] }, force: true, __auditMaintenance: true })
  await db.user.update({ store: null }, { where: { id: created.users } })
  await db.location.destroy({ where: { id: storeIds }, force: true })
  await db.tenant.destroy({ where: { id: tenantIds }, force: true })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.sequelize.close()
  // Never leak the flag into suites that share this worker.
  delete process.env.AUTHZ_OWNER_V2
})

describe('resolver (flag ON)', () => {
  test('owner: canonical owner baseline without the platform tenant.manage', async () => {
    const ctx = await resolveAuthorizationContext(db, { userId: f.ownerA.id })
    expect(ctx.canonicalRole).toBe('owner')
    expect(ctx.permissions).toEqual(expect.arrayContaining(['outlet.create', 'tenant.create', 'finance.manage']))
    expect(ctx.permissions).not.toContain('tenant.manage')
    expect(ctx.permissions).not.toContain('backup.manage')
  })

  test('admin: store-confined for outlet operations, never creates outlets', async () => {
    const ctx = await resolveAuthorizationContext(db, { userId: f.adminA.id })
    expect(ctx.canonicalRole).toBe('admin')
    expect(can(ctx, 'outlet.create', { tenantId: f.tenantA.id })).toBe(false)
    expect(can(ctx, 'outlet.manage', { storeId: f.storeA1.id })).toBe(true)
    expect(can(ctx, 'outlet.manage', { storeId: f.storeA2.id })).toBe(false)
    expect(can(ctx, 'member.manage', { tenantId: f.tenantA.id })).toBe(true)
  })

  test('kasir: only its assigned store, no back-office', async () => {
    const ctx = await resolveAuthorizationContext(db, { userId: f.kasirA.id })
    expect(can(ctx, 'pos.sell', { storeId: f.storeA1.id })).toBe(true)
    expect(can(ctx, 'pos.sell', { storeId: f.storeA2.id })).toBe(false)
    expect(can(ctx, 'catalog.manage', { storeId: f.storeA1.id })).toBe(false)
  })

  test('K1: a legacy tenant_admin keeps its legacy baseline', async () => {
    const ctx = await resolveAuthorizationContext(db, { userId: f.legacyAdmin.id })
    expect(ctx.activeRole).toBe('tenant_admin')
    expect(ctx.canonicalRole).toBe('owner')
    expect(ctx.permissions).toEqual(ROLE_BASELINE_PERMISSIONS.tenant_admin)
  })

  test('platform grant: vendor without any membership, no business operations', async () => {
    const ctx = await resolveAuthorizationContext(db, { userId: f.vendor.id })
    expect(ctx.isPlatformAdmin).toBe(true)
    expect(ctx.activeTenantId).toBeNull()
    expect(ctx.permissions).toContain('tenant.manage')
    expect(ctx.permissions).not.toContain('pos.sell')
    expect(ctx.permissions).not.toContain('finance.manage')
  })
})

describe('P0-1: an owner administers only its own tenants', () => {
  test('owner A lists only tenant A and cannot read, rename or suspend tenant B', async () => {
    const list = await as(f.ownerAToken, 'get', '/tenants?limit=500')
    expect(list.status).toBe(200)
    const rows = list.body?.data?.rows || list.body?.data || []
    const ids = rows.map((t) => t.id)
    expect(ids).toContain(f.tenantA.id)
    expect(ids).not.toContain(f.tenantB.id)

    expect([403, 404]).toContain((await as(f.ownerAToken, 'get', `/tenants/${f.tenantB.id}`)).status)
    const patch = await as(f.ownerAToken, 'patch', `/tenants/${f.tenantB.id}`).send({ status: 'suspended', name: 'hijack' })
    expect([403, 404]).toContain(patch.status)
    const fresh = await db.tenant.findByPk(f.tenantB.id)
    expect(fresh.status).toBe('active')
    expect(fresh.name).not.toBe('hijack')
  })

  test('an admin and a kasir administer no tenant', async () => {
    expect((await as(f.adminAToken, 'get', '/tenants')).status).toBe(403)
    expect((await as(f.kasirAToken, 'get', '/tenants')).status).toBe(403)
  })

  test('K1: a plain legacy tenant_admin stays refused; a store-bound super_admin keeps its own tenants', async () => {
    expect((await as(f.legacyAdminToken, 'get', '/tenants')).status).toBe(403)
    const bakso = await as(f.baksoToken, 'get', '/tenants?limit=500')
    expect(bakso.status).toBe(200)
    const ids = (bakso.body?.data?.rows || bakso.body?.data || []).map((t) => t.id)
    expect(ids).toEqual([f.tenantC.id])
  })

  test('the platform vendor administers every tenant', async () => {
    const list = await as(f.vendorToken, 'get', '/tenants?limit=500')
    expect(list.status).toBe(200)
  })
})

describe('/auth/context onboarding contract', () => {
  const ctxOf = async (token) => (await as(token, 'get', '/auth/context')).body.data.context

  test('a brand-new account must onboard; everyone else must not', async () => {
    expect((await ctxOf(f.freshToken)).onboardingRequired).toBe(true)
    expect((await ctxOf(f.legacyKasirToken)).onboardingRequired).toBe(false)
    expect((await ctxOf(f.vendorToken)).onboardingRequired).toBe(false)
    const owner = await ctxOf(f.ownerAToken)
    expect(owner.onboardingRequired).toBe(false)
    expect(owner.canonicalRole).toBe('owner')
    expect(owner.tenantAdministration).toBe('own')
  })
})

describe('POST /onboarding/tenants', () => {
  test('legacy staff without a membership and the vendor are refused', async () => {
    const body = { code: `ov2-k-${uniq()}`, name: 'Nope' }
    expect((await as(f.legacyKasirToken, 'post', '/onboarding/tenants').send(body)).status).toBe(403)
    expect((await as(f.vendorToken, 'post', '/onboarding/tenants').send(body)).status).toBe(403)
    expect((await as(f.adminAToken, 'post', '/onboarding/tenants').send(body)).status).toBe(403)
  })

  test('a new account becomes the owner of its tenant, capped at 3 per day', async () => {
    const res = await as(f.freshToken, 'post', '/onboarding/tenants').send({ code: `ov2-n-${uniq()}`, name: 'Barber Satu', businessType: 'salon' })
    expect(res.status).toBe(201)
    expect(res.body.data.ownerId).toBe(f.fresh.id)
    expect(res.body.data.businessType).toBe('salon')
    const { owner } = await assertOwnerConsistency(db, res.body.data.id)
    expect(owner.userId).toBe(f.fresh.id)

    // Now an owner: may add tenants, up to the daily cap.
    const second = await as(f.freshToken, 'post', '/onboarding/tenants').send({ code: `ov2-n-${uniq()}`, name: 'Barber Dua' })
    const third = await as(f.freshToken, 'post', '/onboarding/tenants').send({ code: `ov2-n-${uniq()}`, name: 'Barber Tiga' })
    const fourth = await as(f.freshToken, 'post', '/onboarding/tenants').send({ code: `ov2-n-${uniq()}`, name: 'Barber Empat' })
    expect([second.status, third.status, fourth.status]).toEqual([201, 201, 429])
    expect(fourth.body.code).toBe('TENANT_CREATE_RATE_LIMITED')
  })
})

describe('P0-2: outlet creation', () => {
  const outlet = (extra = {}) => ({ name: `OV2_O_${uniq()}`, status: 'active', timezone: 'Asia/Jakarta', ...extra })

  test('owner creates an outlet in its tenant, inheriting the tenant businessType', async () => {
    const res = await as(f.ownerAToken, 'post', '/location/add-new-location').send(outlet())
    expect(res.status).toBe(201)
    const loc = await db.location.findByPk(Number(res.body.data.id))
    expect(loc.tenantId).toBe(f.tenantA.id)
    expect(loc.businessType).toBe('laundry')
  })

  test('a businessType that differs from the tenant is refused', async () => {
    const res = await as(f.ownerAToken, 'post', '/location/add-new-location').send(outlet({ businessType: 'fnb' }))
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('TENANT_BUSINESS_TYPE_MISMATCH')
  })

  test('owner A cannot create an outlet in tenant B', async () => {
    const res = await as(f.ownerAToken, 'post', '/location/add-new-location').send(outlet({ tenantId: f.tenantB.id }))
    expect([403, 422]).toContain(res.status)
    expect(await db.location.count({ where: { tenantId: f.tenantB.id } })).toBe(1)
  })

  test('admin and kasir cannot create outlets', async () => {
    expect((await as(f.adminAToken, 'post', '/location/add-new-location').send(outlet())).status).toBe(403)
    expect((await as(f.kasirAToken, 'post', '/location/add-new-location').send(outlet())).status).toBe(403)
  })

  test('K2: an existing client owner (store-bound super_admin) keeps the legacy path', async () => {
    const res = await as(f.baksoToken, 'post', '/location/add-new-location').send(outlet({ tenantId: f.tenantC.id }))
    expect(res.status).toBe(201)
  })
})

describe('ownership service', () => {
  test('a duplicate tenant code is refused, including retired codes', async () => {
    const u = await mkUser()
    const code = `ov2-d-${uniq()}`
    const { tenant } = await createTenantWithOwner(db, { userId: u.id, code, name: 'Dup', businessType: 'fnb' })
    await tenant.destroy()
    await expect(createTenantWithOwner(db, { userId: u.id, code, name: 'Dup 2', businessType: 'fnb' })).rejects.toMatchObject({ code: 'TENANT_CODE_TAKEN' })
  })

  test('transfer moves ownerId and roles; a deactivated member cannot receive ownership', async () => {
    const a = await mkUser()
    const b = await mkUser()
    const c = await mkUser()
    const { tenant } = await createTenantWithOwner(db, { userId: a.id, code: `ov2-t-${uniq()}`, name: 'Transfer', businessType: 'retail' })
    await member(b, tenant, 'admin')
    await member(c, tenant, 'admin', 'DEACTIVATED')

    await expect(transferTenantOwnership(db, { tenantId: tenant.id, fromUserId: a.id, toUserId: c.id })).rejects.toMatchObject({ code: 'TARGET_NOT_ACTIVE' })
    await expect(transferTenantOwnership(db, { tenantId: tenant.id, fromUserId: b.id, toUserId: b.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await transferTenantOwnership(db, { tenantId: tenant.id, fromUserId: a.id, toUserId: b.id })
    const { tenant: fresh, owner } = await assertOwnerConsistency(db, tenant.id)
    expect(fresh.ownerId).toBe(b.id)
    expect(owner.userId).toBe(b.id)
    const former = await db.tenantMembership.findOne({ where: { tenantId: tenant.id, userId: a.id } })
    expect(former.role).toBe('admin')
  })
})
