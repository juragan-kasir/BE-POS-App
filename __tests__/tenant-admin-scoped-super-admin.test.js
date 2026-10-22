'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// A client's own super admin (store-bound super_admin + tenant_admin
// membership, e.g. bakso_admin) administers ITS tenants on /tenants: list,
// create (becomes tenant_admin), rename and delete-when-empty — never another
// client's tenant, never suspend/resume. Real Postgres test DB; STA_ fixtures
// removed in afterAll.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const P = 'sta'
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const created = { users: [], tenants: [], stores: [] }
let homeTenant
let otherTenant
let homeStore
let bakso
let baksoToken
let platformToken
let boundNoMembershipToken
let plainTenantAdminToken

const mkUser = async (roleType, store = null) => {
  const user = await db.user.create({
    userName: `${P}_${roleType}_${uniq()}`,
    email: `${P}_${uniq()}@test.com`,
    roleType,
    userType: 'admin',
    store,
    status: 'active'
  })
  created.users.push(user.id)
  return user
}

const tokenFor = (user) =>
  signSessionToken({ id: user.id, userName: user.userName, roleType: user.roleType, store: user.store }, JWT_SECRET)

const http = (method, path, token) => request(app)[method](path).set('Authorization', `Bearer ${token}`)

const mkTenant = async (label) => {
  const tenant = await db.tenant.create({ code: `${P}-${label}-${uniq()}`, name: `STA ${label}` })
  created.tenants.push(tenant.id)
  return tenant
}

const baksoCreates = async (name = 'Bakso Cabang Baru') => {
  const res = await http('post', '/tenants', baksoToken).send({ code: `${P}-new-${uniq()}`, name })
  if (res.body?.data?.id) created.tenants.push(res.body.data.id)
  return res
}

const listIds = async (token) => {
  const res = await http('get', '/tenants?limit=100', token)
  return { res, ids: (res.body?.data || []).map((t) => t.id) }
}

beforeAll(async () => {
  homeTenant = await mkTenant('home')
  otherTenant = await mkTenant('other')
  homeStore = await db.location.create({ name: `STA_STORE_${uniq()}`, status: 'draft', tenantId: homeTenant.id })
  created.stores.push(homeStore.id)
  const otherStore = await db.location.create({ name: `STA_OTHER_${uniq()}`, status: 'draft', tenantId: otherTenant.id })
  created.stores.push(otherStore.id)

  bakso = await mkUser('super_admin', homeStore.id)
  await db.tenantMembership.create({ userId: bakso.id, tenantId: homeTenant.id, role: 'tenant_admin', status: 'ACTIVE' })
  baksoToken = await tokenFor(bakso)

  platformToken = await tokenFor(await mkUser('super_admin', null))
  boundNoMembershipToken = await tokenFor(await mkUser('super_admin', homeStore.id))

  const plainAdmin = await mkUser('admin', homeStore.id)
  await db.tenantMembership.create({ userId: plainAdmin.id, tenantId: homeTenant.id, role: 'tenant_admin', status: 'ACTIVE' })
  plainTenantAdminToken = await tokenFor(plainAdmin)
})

afterAll(async () => {
  await db.tenantMembership.destroy({ where: { userId: created.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.location.destroy({ where: { tenantId: created.tenants }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
  await db.auditLog.destroy({
    where: { entity: ['tenant', 'membership', 'location'], tenantId: created.tenants },
    force: true,
    __auditMaintenance: true
  })
  await db.tenant.destroy({ where: { id: created.tenants }, force: true })
})

describe('who administers which tenants', () => {
  test('/auth/context tells the FE: own for bakso, all for platform, none otherwise', async () => {
    const ctxOf = async (token) => (await http('get', '/auth/context', token)).body?.data?.context?.tenantAdministration
    expect(await ctxOf(baksoToken)).toBe('own')
    expect(await ctxOf(platformToken)).toBe('all')
    expect(await ctxOf(boundNoMembershipToken)).toBeNull()
    expect(await ctxOf(plainTenantAdminToken)).toBeNull()
  })

  test('a store-bound super_admin without membership and a plain tenant_admin stay refused', async () => {
    for (const token of [boundNoMembershipToken, plainTenantAdminToken]) {
      expect((await http('get', '/tenants', token)).status).toBe(403)
      expect((await http('post', '/tenants', token).send({ code: `${P}-x-${uniq()}`, name: 'X' })).status).toBe(403)
      expect((await http('delete', `/tenants/${homeTenant.id}`, token)).status).toBe(403)
    }
  })
})

describe('bakso_admin on /tenants', () => {
  test('lists only its own tenant; another client is invisible', async () => {
    const { res, ids } = await listIds(baksoToken)
    expect(res.status).toBe(200)
    expect(ids).toEqual([homeTenant.id])
    expect(res.body.pagination.total).toBe(1)
    expect((await http('get', `/tenants/${otherTenant.id}`, baksoToken)).status).toBe(404)
    expect((await http('get', `/tenants/${homeTenant.id}`, baksoToken)).status).toBe(200)
  })

  test('the platform still lists every tenant', async () => {
    const { ids } = await listIds(platformToken)
    expect(ids).toEqual(expect.arrayContaining([homeTenant.id, otherTenant.id]))
  })

  test('creates a tenant and becomes its tenant_admin; outlets still default to the home tenant', async () => {
    const res = await baksoCreates()
    expect(res.status).toBe(201)
    const newId = res.body.data.id
    const membership = await db.tenantMembership.findOne({ where: { userId: bakso.id, tenantId: newId } })
    expect(membership).toMatchObject({ role: 'tenant_admin', status: 'ACTIVE' })
    const audits = await db.auditLog.findAll({ where: { entity: 'membership', entityId: membership.id } })
    expect(audits).toHaveLength(1)

    const { ids } = await listIds(baksoToken)
    expect(ids.sort()).toEqual([homeTenant.id, newId].sort())

    // two memberships now: the context defaults to the home store's tenant
    const ctx = (await http('get', '/auth/context', baksoToken)).body.data.context
    expect(ctx.activeTenantId).toBe(homeTenant.id)
    expect(ctx.activeRole).toBe('tenant_admin')

    const loc = await http('post', '/location/add-new-location', baksoToken).field(
      'data',
      JSON.stringify({ name: `STA_OUTLET_${uniq()}`, category: 'Warehouse', status: 'active', address: 'Jl. 1', phoneNumber: '081200000000' })
    )
    expect(loc.status).toBe(201)
    created.stores.push(loc.body.data.id)
    expect((await db.location.findByPk(loc.body.data.id)).tenantId).toBe(homeTenant.id)
  })

  test('renames its own tenant, cannot suspend it, cannot touch another client', async () => {
    const renamed = await http('patch', `/tenants/${homeTenant.id}`, baksoToken).send({ name: 'Bakso Pusat' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.data.name).toBe('Bakso Pusat')

    const suspend = await http('patch', `/tenants/${homeTenant.id}`, baksoToken).send({ status: 'suspended' })
    expect(suspend.status).toBe(403)
    expect(suspend.body.code).toBe('TENANT_STATUS_PLATFORM_ONLY')
    expect((await db.tenant.findByPk(homeTenant.id)).status).toBe('active')

    expect((await http('patch', `/tenants/${otherTenant.id}`, baksoToken).send({ name: 'Hacked' })).status).toBe(404)
    expect((await db.tenant.findByPk(otherTenant.id)).name).toBe('STA other')
  })
})

describe('DELETE /tenants/:id', () => {
  test('refuses a tenant that still has stores', async () => {
    const res = await http('delete', `/tenants/${homeTenant.id}`, baksoToken)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TENANT_HAS_STORES')
    expect(await db.tenant.findByPk(homeTenant.id)).not.toBeNull()
  })

  test('refuses a tenant with another active member', async () => {
    const res = await baksoCreates('Bakso Shared')
    const id = res.body.data.id
    const staff = await mkUser('admin', homeStore.id)
    await db.tenantMembership.create({ userId: staff.id, tenantId: id, role: 'staff', status: 'ACTIVE' })
    const del = await http('delete', `/tenants/${id}`, baksoToken)
    expect(del.status).toBe(409)
    expect(del.body.code).toBe('TENANT_HAS_MEMBERS')
  })

  test('soft-deletes an empty tenant, retires memberships and keeps the code reserved', async () => {
    const res = await baksoCreates('Bakso Salah Buat')
    const id = res.body.data.id
    const code = res.body.data.code
    const del = await http('delete', `/tenants/${id}`, baksoToken)
    expect(del.status).toBe(200)

    expect(await db.tenant.findByPk(id)).toBeNull()
    expect(await db.tenant.findByPk(id, { paranoid: false })).not.toBeNull()
    const m = await db.tenantMembership.findOne({ where: { userId: bakso.id, tenantId: id } })
    expect(m.status).toBe('RETIRED')
    expect((await listIds(baksoToken)).ids).not.toContain(id)
    const audit = await db.auditLog.findOne({ where: { entity: 'tenant', entityId: id, action: 'delete' } })
    expect(audit).not.toBeNull()

    const again = await http('post', '/tenants', platformToken).send({ code, name: 'Reuse' })
    expect(again.status).toBe(409)
  })

  test('cannot delete another client tenant (404), the platform can delete an empty one', async () => {
    const empty = await mkTenant('empty')
    expect((await http('delete', `/tenants/${empty.id}`, baksoToken)).status).toBe(404)
    expect((await http('delete', `/tenants/${empty.id}`, platformToken)).status).toBe(200)
    expect(await db.tenant.findByPk(empty.id)).toBeNull()
  })
})
