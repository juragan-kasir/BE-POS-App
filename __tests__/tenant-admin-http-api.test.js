'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Platform tenant administration: /tenants list / detail / create / update,
// gated by tenant.manage (platform actors only), audited in-transaction, and
// the platform store-creation flow it unblocks (TARGET_TENANT_REQUIRED).
// Real Postgres test DB; TADM_ fixtures removed in afterAll.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const P = 'tadm'
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const created = { users: [], tenants: [], stores: [] }
let platformUser
let platformToken
let boundSuperToken
let tenantAdminToken
let homeTenant
let homeStore

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

const createTenant = async (body) => {
  const res = await http('post', '/tenants', platformToken).send(body)
  if (res.body?.data?.id) created.tenants.push(res.body.data.id)
  return res
}

const auditRows = (tenantId) =>
  db.auditLog.findAll({ where: { entity: 'tenant', entityId: tenantId }, order: [['id', 'ASC']] })

beforeAll(async () => {
  homeTenant = await db.tenant.create({ code: `${P}-home-${uniq()}`, name: 'TADM Home' })
  created.tenants.push(homeTenant.id)
  homeStore = await db.location.create({ name: `TADM_STORE_${uniq()}`, status: 'draft', tenantId: homeTenant.id })
  created.stores.push(homeStore.id)

  platformUser = await mkUser('super_admin', null)
  platformToken = await tokenFor(platformUser)

  const boundSuper = await mkUser('super_admin', homeStore.id)
  boundSuperToken = await tokenFor(boundSuper)

  const tenantAdmin = await mkUser('admin', homeStore.id)
  await db.tenantMembership.create({ userId: tenantAdmin.id, tenantId: homeTenant.id, role: 'tenant_admin', status: 'ACTIVE' })
  tenantAdminToken = await tokenFor(tenantAdmin)
})

afterAll(async () => {
  // Users first: user.store references location.
  await db.tenantMembership.destroy({ where: { userId: created.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.location.destroy({ where: { tenantId: created.tenants }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
  await db.auditLog.destroy({ where: { entity: 'tenant', entityId: created.tenants }, force: true, __auditMaintenance: true })
  await db.tenant.destroy({ where: { id: created.tenants }, force: true })
})

describe('authorization — tenant.manage is platform-only', () => {
  test.each([
    ['get', '/tenants'],
    ['post', '/tenants'],
    ['patch', '/tenants/1']
  ])('a store-bound super_admin is refused %s %s', async (method, path) => {
    const res = await http(method, path, boundSuperToken).send({ code: 'x', name: 'x' })
    expect(res.status).toBe(403)
  })

  test('a tenant_admin is refused (no cross-tenant administration)', async () => {
    expect((await http('get', '/tenants', tenantAdminToken)).status).toBe(403)
    const res = await http('post', '/tenants', tenantAdminToken).send({ code: `${P}-x-${uniq()}`, name: 'X' })
    expect(res.status).toBe(403)
  })

  test('an anonymous caller is refused', async () => {
    expect((await request(app).get('/tenants')).status).toBe(401)
  })
})

describe('POST /tenants', () => {
  test('creates an active tenant, normalizes code/name and audits it', async () => {
    const code = `${P}-bakso-${uniq()}`
    const res = await createTenant({ code: `  ${code.toUpperCase()} `, name: '  Warung   Bakso  ' })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ code, name: 'Warung Bakso', status: 'active', storeCount: 0, activeMemberCount: 0 })
    const audits = await auditRows(res.body.data.id)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: 'create', userId: platformUser.id, tenantId: res.body.data.id })
  })

  test.each([
    [{ name: 'No code' }, 'INVALID_CODE'],
    [{ code: 'has space', name: 'X' }, 'INVALID_CODE'],
    [{ code: '-leading', name: 'X' }, 'INVALID_CODE'],
    [{ code: 'a'.repeat(51), name: 'X' }, 'INVALID_CODE'],
    [{ code: `${P}-ok`, name: '   ' }, 'INVALID_NAME'],
    [{ code: `${P}-ok`, name: 'n'.repeat(101) }, 'INVALID_NAME']
  ])('rejects %j with %s and writes nothing', async (body, code) => {
    const before = await db.tenant.count()
    const res = await createTenant(body)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(code)
    expect(await db.tenant.count()).toBe(before)
  })

  test('a duplicate code is 409, including a retired (soft-deleted) tenant code', async () => {
    const code = `${P}-dup-${uniq()}`
    const first = await createTenant({ code, name: 'First' })
    expect(first.status).toBe(201)
    expect((await createTenant({ code, name: 'Second' })).body.code).toBe('TENANT_CODE_TAKEN')

    await db.tenant.destroy({ where: { id: first.body.data.id } })
    const reuse = await createTenant({ code, name: 'Third' })
    expect(reuse.status).toBe(409)
    expect(reuse.body.code).toBe('TENANT_CODE_TAKEN')
  })
})

describe('GET /tenants', () => {
  test('lists with store / active-member counts, search and status filters', async () => {
    const code = `${P}-list-${uniq()}`
    const res = await createTenant({ code, name: 'Listing Tenant' })
    const id = res.body.data.id
    const store = await db.location.create({ name: `TADM_LIST_${uniq()}`, status: 'draft', tenantId: id })
    created.stores.push(store.id)

    const list = await http('get', `/tenants?search=${code}`, platformToken)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toMatchObject({ id, code, storeCount: 1 })
    expect(list.body.pagination).toMatchObject({ page: 1, total: 1 })

    const suspendedOnly = await http('get', `/tenants?search=${code}&status=suspended`, platformToken)
    expect(suspendedOnly.body.data).toHaveLength(0)
    expect((await http('get', '/tenants?status=bogus', platformToken)).status).toBe(400)
  })

  test('search treats LIKE wildcards literally', async () => {
    const res = await http('get', '/tenants?search=%25', platformToken)
    expect(res.status).toBe(200)
    expect(res.body.data.every((t) => t.name.includes('%') || t.code.includes('%'))).toBe(true)
  })

  test('GET /tenants/:id returns one tenant; unknown or malformed id is 404', async () => {
    const one = await http('get', `/tenants/${homeTenant.id}`, platformToken)
    expect(one.status).toBe(200)
    expect(one.body.data).toMatchObject({ id: homeTenant.id, activeMemberCount: 1 })
    expect((await http('get', '/tenants/2000000000', platformToken)).status).toBe(404)
    expect((await http('get', '/tenants/abc', platformToken)).status).toBe(404)
  })
})

describe('PATCH /tenants/:id', () => {
  test('renames and suspends/resumes, auditing each real change only', async () => {
    const res = await createTenant({ code: `${P}-upd-${uniq()}`, name: 'Before' })
    const id = res.body.data.id

    const renamed = await http('patch', `/tenants/${id}`, platformToken).send({ name: 'After' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.data.name).toBe('After')

    const suspended = await http('patch', `/tenants/${id}`, platformToken).send({ status: 'suspended' })
    expect(suspended.body.data.status).toBe('suspended')

    // idempotent repeat: no write, no audit row
    const again = await http('patch', `/tenants/${id}`, platformToken).send({ status: 'suspended' })
    expect(again.status).toBe(200)

    const audits = await auditRows(id)
    expect(audits.map((a) => a.action)).toEqual(['create', 'update', 'update'])
    expect(audits[2].oldValues).toMatchObject({ status: 'active' })
    expect(audits[2].newValues).toMatchObject({ status: 'suspended' })
  })

  test.each([
    [{ code: 'new-code' }, 'CODE_IMMUTABLE'],
    [{ status: 'deleted' }, 'INVALID_STATUS'],
    [{ name: '' }, 'INVALID_NAME'],
    [{}, 'INVALID_OPERATION']
  ])('rejects %j with %s', async (body, code) => {
    const res = await http('patch', `/tenants/${homeTenant.id}`, platformToken).send(body)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(code)
  })

  test('unknown tenant is 404', async () => {
    const res = await http('patch', '/tenants/2000000000', platformToken).send({ name: 'X' })
    expect(res.status).toBe(404)
  })
})

describe('platform store creation with a target tenant (TARGET_TENANT_REQUIRED fix path)', () => {
  const storePayload = (overrides = {}) => ({
    name: `TADM_LOC_${uniq()}`,
    phoneNumber: '081234567890',
    email: `${P}_${uniq()}@test.com`,
    address: 'Jl. Bakso No. 1',
    province: '31',
    city: '3171',
    district: '3171010',
    village: '3171010001',
    postalCode: '10110',
    status: 'active',
    ...overrides
  })

  test('without tenantId an active store is still refused', async () => {
    const res = await http('post', '/location/add-new-location', platformToken).send(storePayload())
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('TARGET_TENANT_REQUIRED')
  })

  test('with a tenant created here the active store is created under it', async () => {
    const tenant = await createTenant({ code: `${P}-store-${uniq()}`, name: 'Store Owner' })
    const res = await http('post', '/location/add-new-location', platformToken).send(
      storePayload({ tenantId: tenant.body.data.id })
    )
    expect([200, 201]).toContain(res.status)
    const row = await db.location.findByPk(res.body.data.id)
    expect(row).toMatchObject({ tenantId: tenant.body.data.id, status: 'active' })
  })

  test('activating a draft store that already has a tenant needs no tenantId restated', async () => {
    const tenant = await createTenant({ code: `${P}-pub-${uniq()}`, name: 'Publish' })
    const draft = await db.location.create({
      name: `TADM_DRAFT_${uniq()}`,
      status: 'draft',
      tenantId: tenant.body.data.id
    })
    created.stores.push(draft.id)
    const res = await http('put', '/location/edit-location', platformToken).send({ id: draft.id, status: 'active' })
    expect(res.status).toBe(200)
    expect(await db.location.findByPk(draft.id)).toMatchObject({ status: 'active', tenantId: tenant.body.data.id })
  })

  test('a draft store of a suspended tenant cannot be activated', async () => {
    const tenant = await createTenant({ code: `${P}-sdr-${uniq()}`, name: 'Suspended Draft' })
    const draft = await db.location.create({
      name: `TADM_SDRAFT_${uniq()}`,
      status: 'draft',
      tenantId: tenant.body.data.id
    })
    created.stores.push(draft.id)
    await http('patch', `/tenants/${tenant.body.data.id}`, platformToken).send({ status: 'suspended' })
    const res = await http('put', '/location/edit-location', platformToken).send({ id: draft.id, status: 'active' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('TENANT_NOT_APPROVED')
    expect((await db.location.findByPk(draft.id)).status).toBe('draft')
  })

  test('a suspended tenant cannot receive an active store', async () => {
    const tenant = await createTenant({ code: `${P}-susp-${uniq()}`, name: 'Suspended' })
    await http('patch', `/tenants/${tenant.body.data.id}`, platformToken).send({ status: 'suspended' })
    const res = await http('post', '/location/add-new-location', platformToken).send(
      storePayload({ tenantId: tenant.body.data.id })
    )
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('TENANT_NOT_APPROVED')
  })
})
