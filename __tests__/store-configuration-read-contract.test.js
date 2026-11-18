process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const jwt = require('jsonwebtoken')
const app = require('../api/index')
const db = require('../db/models')
const mw = require('../utils/authorizationContextMiddleware')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// W3 read follow-up contract:
//   GET /location/store-configuration/:id
//   GET /location/store-configuration?page&limit
//
// - Admission is canonical (store.manage), identical to the W3 mutation:
//   platform_admin cross-tenant (confined when a tenant is selected),
//   tenant_admin own-tenant; store_admin/cashier/staff and a store-bound
//   legacy super_admin without memberships are denied.
// - Selector: unpadded loc-N only. Missing, malformed, zero-padded and
//   foreign selectors, and tenantless rows for non-platform actors, are a
//   uniform 403. Authorized soft-deleted rows are 404.
// - Terminal stores (closed/retired/quarantined) are readable.
// - The projection carries the persisted configuration fields; the locked
//   W3 PUT response is unchanged.

const CONFIG_FIELDS = ['description', 'timezone', 'maxActiveParkedCarts', 'parkedCartTtlMinutes']

// The original shared detail projection (pre read follow-up). The W3 PUT
// response must keep exactly this key set.
const BASE_PROJECTION_KEYS = [
  'id',
  'storeId',
  'name',
  'address',
  'detailLocation',
  'phoneNumber',
  'email',
  'image',
  'isActive',
  'status',
  'city',
  'cityName',
  'province',
  'provinceName',
  'district',
  'districtName',
  'village',
  'villageName',
  'postalCode',
  'category',
  'managerName',
  'latitude',
  'longitude',
  'mainBranch',
  'dailyTarget',
  // Shared-domain fields (2026-11-14). laundrySettings is the public view
  // (no ownerPinHash) — see db/models/location.js.
  'businessType',
  'laundrySettings',
  'createdAt',
  'updatedAt',
  'createdBy',
  'createdByUser',
  'modifiedBy',
  'modifiedByUser',
  'openingHours',
  'socialMedia'
]

const stamp = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
const locId = (id) => `loc-${id}`
// Zero-padded selector form (the projector pads to 3 digits, e.g. loc-001;
// fixture ids are already wider, so pad explicitly with a leading zero).
const paddedId = (id) => `loc-0${id}`
const projectedId = (id) => `loc-${String(id).padStart(3, '0')}`

const nextLocationId = async () => {
  const [rows] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id")
  return Number(rows?.[0]?.id)
}

const userIds = []
const tenantIds = []
const storeIds = []

const makeUser = async (attrs) => {
  const user = await db.user.create({
    userName: `w3r_${attrs.roleType}_${stamp()}`,
    email: `w3r_${stamp()}@test.com`,
    status: 'active',
    ...attrs
  })
  userIds.push(user.id)
  return user
}

const makeTenant = async () => {
  const tenant = await db.tenant.create({
    code: `W3R_${stamp()}`.slice(0, 50),
    name: `W3R Tenant ${stamp()}`
  })
  tenantIds.push(tenant.id)
  return tenant
}

const makeStore = async (tenantId, status = 'active', overrides = {}) => {
  const row = await db.location.create({
    id: await nextLocationId(),
    store: null,
    tenantId,
    name: `W3RSTORE_${stamp()}`,
    status,
    ...overrides
  })
  storeIds.push(row.id)
  return row
}

const member = (user, tenant, role) =>
  db.tenantMembership.create({ userId: user.id, tenantId: tenant.id, role, status: 'ACTIVE' })

const assign = (user, store) =>
  db.storeAssignment.create({ userId: user.id, tenantId: store.tenantId, storeId: store.id })

const sessionFor = async (user, tenantId = null) => {
  const s = await mw.createContextSession(db, { userId: user.id })
  if (tenantId != null) await mw.switchSessionTenant(db, s.sessionId, user.id, tenantId)
  return jwt.sign({ id: user.id, sessionId: s.sessionId }, JWT_SECRET)
}

const getOne = (token, id) => {
  const r = request(app).get(`/location/store-configuration/${encodeURIComponent(id)}`)
  if (token) r.set('Authorization', `Bearer ${token}`)
  return r
}

const getList = (token, query = {}) => {
  const r = request(app).get('/location/store-configuration').query(query)
  if (token) r.set('Authorization', `Bearer ${token}`)
  return r
}

const put = (token, body) =>
  request(app)
    .put('/location/store-configuration')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

// Walks every page of the list for an actor and returns the projected ids.
const collectIds = async (token) => {
  const ids = []
  let pageNo = 1
  for (;;) {
    const res = await getList(token, { page: pageNo, limit: 100 })
    expect(res.status).toBe(200)
    ids.push(...res.body.data.map((item) => item.id))
    if (pageNo >= res.body.pagination.totalPages) break
    pageNo += 1
  }
  return ids
}

let tenantA
let tenantB
let tenantEmpty
let storeA1
let storeA2
let storeB1
let storeTenantless
let storeInactive
let storeDraft
let storeClosed
let storeRetired
let storeQuarantined
let storeDeleted
let storeTenantlessDeleted
let tenantAReadable
let platformToken
let platformMemberAToken
let tenantAdminAToken
let tenantAdminBToken
let tenantAdminEmptyToken
let storeAdminToken
let cashierToken
let staffToken
let boundSuperToken

beforeAll(async () => {
  tenantA = await makeTenant()
  tenantB = await makeTenant()
  tenantEmpty = await makeTenant()

  storeA1 = await makeStore(tenantA.id, 'active', {
    description: 'W3R configured store',
    timezone: 'Asia/Makassar',
    maxActiveParkedCarts: 7,
    parkedCartTtlMinutes: 45,
    managerName: 'W3R Manager',
    socialMedia: [{ platform: 'instagram', account: '@w3r' }]
  })
  storeA2 = await makeStore(tenantA.id, 'active')
  storeB1 = await makeStore(tenantB.id, 'active')
  storeTenantless = await makeStore(null, 'draft')
  storeInactive = await makeStore(tenantA.id, 'inactive')
  storeDraft = await makeStore(tenantA.id, 'draft')
  storeClosed = await makeStore(tenantA.id, 'closed')
  storeRetired = await makeStore(tenantA.id, 'retired')
  storeQuarantined = await makeStore(tenantA.id, 'quarantined')
  storeDeleted = await makeStore(tenantA.id, 'active')
  await db.location.destroy({ where: { id: storeDeleted.id } })
  storeTenantlessDeleted = await makeStore(null, 'draft')
  await db.location.destroy({ where: { id: storeTenantlessDeleted.id } })

  tenantAReadable = [
    storeA1,
    storeA2,
    storeInactive,
    storeDraft,
    storeClosed,
    storeRetired,
    storeQuarantined
  ]
    .map((s) => s.id)
    .sort((a, b) => a - b)

  const platform = await makeUser({ roleType: 'super_admin', store: null })
  platformToken = await sessionFor(platform)

  const platformMemberA = await makeUser({ roleType: 'admin', store: null })
  await member(platformMemberA, tenantA, 'platform_admin')
  platformMemberAToken = await sessionFor(platformMemberA, tenantA.id)

  const tenantAdminA = await makeUser({ roleType: 'admin', store: null })
  await member(tenantAdminA, tenantA, 'tenant_admin')
  tenantAdminAToken = await sessionFor(tenantAdminA, tenantA.id)

  const tenantAdminB = await makeUser({ roleType: 'admin', store: null })
  await member(tenantAdminB, tenantB, 'tenant_admin')
  tenantAdminBToken = await sessionFor(tenantAdminB, tenantB.id)

  const tenantAdminEmpty = await makeUser({ roleType: 'admin', store: null })
  await member(tenantAdminEmpty, tenantEmpty, 'tenant_admin')
  tenantAdminEmptyToken = await sessionFor(tenantAdminEmpty, tenantEmpty.id)

  const storeAdmin = await makeUser({ roleType: 'admin', store: null })
  await member(storeAdmin, tenantA, 'store_admin')
  await assign(storeAdmin, storeA1)
  storeAdminToken = await sessionFor(storeAdmin, tenantA.id)

  const cashier = await makeUser({ roleType: 'kasir', store: null })
  await member(cashier, tenantA, 'cashier')
  await assign(cashier, storeA1)
  cashierToken = await sessionFor(cashier, tenantA.id)

  const staff = await makeUser({ roleType: 'user', store: null })
  await member(staff, tenantA, 'staff')
  staffToken = await sessionFor(staff, tenantA.id)

  const boundSuper = await makeUser({ roleType: 'super_admin', store: storeA1.id })
  boundSuperToken = await sessionFor(boundSuper)
}, 60000)

afterAll(async () => {
  const loud = (label) => (error) => {
    if (error) console.error(`W3R cleanup ${label}:`, error.message)
  }
  await db.authorizationContextSession.destroy({ where: { userId: userIds }, force: true }).catch(loud('sessions'))
  await db.storeAssignment.destroy({ where: { userId: userIds }, force: true }).catch(loud('assignments'))
  await db.tenantMembership.destroy({ where: { userId: userIds }, force: true }).catch(loud('memberships'))
  // user.store carries a DB-level FK to location (user_store_fkey): null it
  // before removing the referenced stores.
  await db.user.update({ store: null }, { where: { id: userIds } }).catch(loud('user-store'))
  await db.location.destroy({ where: { id: storeIds }, force: true }).catch(loud('locations'))
  await db.user.destroy({ where: { id: userIds }, force: true }).catch(loud('users'))
  await db.tenant.destroy({ where: { id: tenantIds }, force: true }).catch(loud('tenants'))
  // The regression PUT emits fire-and-forget audit/notification writes.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await db.auditLog
    .destroy({ where: { userId: userIds }, __auditMaintenance: true })
    .catch(loud('auditLog'))
  await db.notification
    .destroy({ where: { referenceType: 'location', referenceId: storeIds }, force: true })
    .catch(loud('notification'))
})

describe('GET /location/store-configuration/:id — admission', () => {
  test('platform_admin reads an own-tenant store with configuration fields', async () => {
    const res = await getOne(platformToken, locId(storeA1.id))
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.id).toBe(projectedId(storeA1.id))
    expect(res.body.data.description).toBe('W3R configured store')
    expect(res.body.data.timezone).toBe('Asia/Makassar')
    expect(Number(res.body.data.maxActiveParkedCarts)).toBe(7)
    expect(Number(res.body.data.parkedCartTtlMinutes)).toBe(45)
  })

  test('tenant_admin reads an own-tenant store', async () => {
    const res = await getOne(tenantAdminAToken, locId(storeA1.id))
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(projectedId(storeA1.id))
  })

  test('platform_admin reads cross-tenant and tenantless rows', async () => {
    const cross = await getOne(platformToken, locId(storeB1.id))
    expect(cross.status).toBe(200)
    expect(cross.body.data.id).toBe(projectedId(storeB1.id))
    const tenantless = await getOne(platformToken, locId(storeTenantless.id))
    expect(tenantless.status).toBe(200)
    expect(tenantless.body.data.id).toBe(projectedId(storeTenantless.id))
  })

  test('platform_admin with a selected tenant is confined to that tenant', async () => {
    expect((await getOne(platformMemberAToken, locId(storeA1.id))).status).toBe(200)
    expect((await getOne(platformMemberAToken, locId(storeB1.id))).status).toBe(403)
    expect((await getOne(platformMemberAToken, locId(storeTenantless.id))).status).toBe(403)
  })

  test.each([
    ['store_admin', () => storeAdminToken],
    ['cashier', () => cashierToken],
    ['staff', () => staffToken],
    ['store-bound legacy super_admin without memberships', () => boundSuperToken]
  ])('%s without store.manage is denied', async (_label, getToken) => {
    const res = await getOne(getToken(), locId(storeA1.id))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN')
    expect(res.body.data).toBeUndefined()
  })

  test('unauthenticated is 401', async () => {
    const res = await getOne(null, locId(storeA1.id))
    expect(res.status).toBe(401)
  })
})

describe('GET /location/store-configuration/:id — isolation and selectors', () => {
  test('tenant_admin cannot read another tenant store (both directions)', async () => {
    const forward = await getOne(tenantAdminAToken, locId(storeB1.id))
    expect(forward.status).toBe(403)
    expect(forward.body.data).toBeUndefined()
    const reverse = await getOne(tenantAdminBToken, locId(storeA1.id))
    expect(reverse.status).toBe(403)
  })

  test('tenantless row is platform-only', async () => {
    const res = await getOne(tenantAdminAToken, locId(storeTenantless.id))
    expect(res.status).toBe(403)
  })

  test('missing, foreign, malformed and padded selectors are indistinguishable 403s', async () => {
    const responses = await Promise.all([
      getOne(tenantAdminAToken, 'loc-2000000000'),
      getOne(tenantAdminAToken, locId(storeB1.id)),
      getOne(tenantAdminAToken, 'loc-abc'),
      getOne(tenantAdminAToken, String(storeA1.id)),
      getOne(tenantAdminAToken, 'loc-0'),
      getOne(tenantAdminAToken, 'loc-001'),
      getOne(tenantAdminAToken, paddedId(storeA1.id))
    ])
    for (const res of responses) {
      expect(res.status).toBe(403)
      expect(res.body).toEqual(responses[0].body)
    }
  })

  test('a zero-padded selector is 403 even for platform_admin on an existing row', async () => {
    // Normalization (loc-001 -> loc-1) belongs to the FE W3 wrapper only; the
    // server selector stays strict, exactly like the W3 mutation.
    const padded = paddedId(storeA1.id)
    expect(padded).not.toBe(locId(storeA1.id))
    const res = await getOne(platformToken, padded)
    expect(res.status).toBe(403)
    const normalized = await getOne(platformToken, locId(storeA1.id))
    expect(normalized.status).toBe(200)
  })
})

describe('GET /location/store-configuration/:id — lifecycle', () => {
  test.each([
    ['active', () => storeA2],
    ['inactive', () => storeInactive],
    ['draft', () => storeDraft],
    ['closed', () => storeClosed],
    ['retired', () => storeRetired],
    ['quarantined', () => storeQuarantined]
  ])('%s store is readable with its status', async (status, getStore) => {
    const store = getStore()
    for (const token of [platformToken, tenantAdminAToken]) {
      const res = await getOne(token, locId(store.id))
      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe(status)
    }
    // Reading never mutates lifecycle.
    expect((await db.location.findByPk(store.id)).status).toBe(status)
  })

  test('terminal store stays readable while its mutation remains 422', async () => {
    const read = await getOne(tenantAdminAToken, locId(storeClosed.id))
    expect(read.status).toBe(200)
    const write = await put(tenantAdminAToken, { id: locId(storeClosed.id), managerName: 'W3R Denied' })
    expect(write.status).toBe(422)
    expect(write.body.code).toBe('STORE_STATUS_IRREVERSIBLE')
  })

  test('authorized soft-deleted store is 404', async () => {
    for (const token of [platformToken, tenantAdminAToken]) {
      const res = await getOne(token, locId(storeDeleted.id))
      expect(res.status).toBe(404)
      expect(res.body.success).toBe(false)
    }
    const tenantlessDeleted = await getOne(platformToken, locId(storeTenantlessDeleted.id))
    expect(tenantlessDeleted.status).toBe(404)
  })

  test('foreign soft-deleted store stays 403 (no existence revelation)', async () => {
    expect((await getOne(tenantAdminBToken, locId(storeDeleted.id))).status).toBe(403)
    expect((await getOne(tenantAdminAToken, locId(storeTenantlessDeleted.id))).status).toBe(403)
  })
})

describe('GET /location/store-configuration/:id — projection', () => {
  test('response carries the full existing projection plus configuration fields', async () => {
    const res = await getOne(platformToken, locId(storeA1.id))
    expect(res.status).toBe(200)
    expect(Object.keys(res.body.data).sort()).toEqual(
      [...BASE_PROJECTION_KEYS, ...CONFIG_FIELDS].sort()
    )
    expect(res.body.data.name).toBe(storeA1.name)
    expect(res.body.data.managerName).toBe('W3R Manager')
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.isActive).toBe(true)
    expect(res.body.data.storeId).toBe(`ST-${String(storeA1.id).padStart(3, '0')}`)
    expect(Array.isArray(res.body.data.openingHours)).toBe(true)
    expect(res.body.data.socialMedia).toEqual([{ platform: 'instagram', account: '@w3r' }])
  })

  test('ownership and session fields are never projected', async () => {
    const res = await getOne(platformToken, locId(storeA1.id))
    expect(res.body.data.tenantId).toBeUndefined()
    expect(res.body.data.store).toBeUndefined()
    expect(res.body.data.deletedAt).toBeUndefined()
  })

  test('unset configuration values are the persisted defaults/nulls', async () => {
    const res = await getOne(platformToken, locId(storeA2.id))
    expect(res.status).toBe(200)
    expect(res.body.data.description).toBeNull()
    expect(res.body.data.timezone).toBe('Asia/Jakarta')
    expect(res.body.data.maxActiveParkedCarts).toBeNull()
    expect(res.body.data.parkedCartTtlMinutes).toBeNull()
  })
})

describe('GET /location/store-configuration — tenant-scoped list', () => {
  test('tenant_admin lists exactly its active tenant stores, terminal included', async () => {
    const res = await getList(tenantAdminAToken, { limit: 100 })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.pagination).toEqual({
      page: 1,
      limit: 100,
      total: tenantAReadable.length,
      totalPages: 1
    })
    expect(res.body.data.map((item) => item.id)).toEqual(tenantAReadable.map(projectedId))
    const statuses = res.body.data.map((item) => item.status)
    expect(statuses).toEqual(expect.arrayContaining(['closed', 'retired', 'quarantined']))
  })

  test('every item carries the configuration projection', async () => {
    const res = await getList(tenantAdminAToken, { limit: 100 })
    for (const item of res.body.data) {
      expect(Object.keys(item).sort()).toEqual([...BASE_PROJECTION_KEYS, ...CONFIG_FIELDS].sort())
    }
    const a1 = res.body.data.find((item) => item.id === projectedId(storeA1.id))
    expect(a1.description).toBe('W3R configured store')
    expect(a1.timezone).toBe('Asia/Makassar')
    expect(Number(a1.maxActiveParkedCarts)).toBe(7)
    expect(Number(a1.parkedCartTtlMinutes)).toBe(45)
  })

  test('soft-deleted, foreign and tenantless rows never leak into a tenant list', async () => {
    const ids = (await getList(tenantAdminAToken, { limit: 100 })).body.data.map((item) => item.id)
    expect(ids).not.toContain(projectedId(storeDeleted.id))
    expect(ids).not.toContain(projectedId(storeB1.id))
    expect(ids).not.toContain(projectedId(storeTenantless.id))
    const b = await getList(tenantAdminBToken)
    expect(b.status).toBe(200)
    expect(b.body.data.map((item) => item.id)).toEqual([projectedId(storeB1.id)])
    expect(b.body.pagination.total).toBe(1)
  })

  test('platform_admin with a selected tenant lists only that tenant', async () => {
    const res = await getList(platformMemberAToken, { limit: 100 })
    expect(res.status).toBe(200)
    expect(res.body.data.map((item) => item.id)).toEqual(tenantAReadable.map(projectedId))
  })

  test('platform_admin without a tenant lists platform-wide, tenantless included, deleted excluded', async () => {
    const ids = await collectIds(platformToken)
    for (const id of [...tenantAReadable, storeB1.id, storeTenantless.id]) {
      expect(ids).toContain(projectedId(id))
    }
    expect(ids).not.toContain(projectedId(storeDeleted.id))
    expect(ids).not.toContain(projectedId(storeTenantlessDeleted.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('empty tenant returns an empty page', async () => {
    const res = await getList(tenantAdminEmptyToken)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 })
  })

  test.each([
    ['store_admin', () => storeAdminToken],
    ['cashier', () => cashierToken],
    ['staff', () => staffToken],
    ['store-bound legacy super_admin without memberships', () => boundSuperToken]
  ])('%s without store.manage is denied', async (_label, getToken) => {
    const res = await getList(getToken())
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN')
    expect(res.body.data).toBeUndefined()
  })

  test('unauthenticated is 401', async () => {
    expect((await getList(null)).status).toBe(401)
  })

  test('client-supplied tenant/store parameters never widen the scope', async () => {
    const res = await getList(tenantAdminAToken, {
      limit: 100,
      tenantId: tenantB.id,
      store: storeB1.id,
      storeId: storeB1.id
    })
    expect(res.status).toBe(200)
    expect(res.body.data.map((item) => item.id)).toEqual(tenantAReadable.map(projectedId))
  })
})

describe('GET /location/store-configuration — pagination', () => {
  test('pages partition the readable set in ascending id order', async () => {
    const pages = []
    for (const pageNo of [1, 2, 3]) {
      const res = await getList(tenantAdminAToken, { page: pageNo, limit: 3 })
      expect(res.status).toBe(200)
      expect(res.body.pagination).toEqual({
        page: pageNo,
        limit: 3,
        total: tenantAReadable.length,
        totalPages: Math.ceil(tenantAReadable.length / 3)
      })
      pages.push(res.body.data.map((item) => item.id))
    }
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1])
    expect(pages.flat()).toEqual(tenantAReadable.map(projectedId))
  })

  test('a page past the end is empty with intact totals', async () => {
    const res = await getList(tenantAdminAToken, { page: 4, limit: 3 })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    expect(res.body.pagination).toEqual({
      page: 4,
      limit: 3,
      total: tenantAReadable.length,
      totalPages: 3
    })
  })

  test('defaults and caps follow the canonical list contract', async () => {
    const defaults = await getList(tenantAdminAToken)
    expect(defaults.body.pagination).toMatchObject({ page: 1, limit: 20 })
    const capped = await getList(tenantAdminAToken, { limit: 1000 })
    expect(capped.body.pagination.limit).toBe(100)
    const invalid = await getList(tenantAdminAToken, { page: 0, limit: 'abc' })
    expect(invalid.body.pagination).toMatchObject({ page: 1, limit: 20 })
    const negative = await getList(tenantAdminAToken, { page: -2, limit: -5 })
    expect(negative.body.pagination).toMatchObject({ page: 1, limit: 20 })
    const fractional = await getList(tenantAdminAToken, { page: 1.5, limit: 2.5 })
    expect(fractional.body.pagination).toMatchObject({ page: 1, limit: 20 })
  })
})

describe('Read follow-up regressions', () => {
  test('W3 PUT response keeps exactly the original projection (no configuration fields)', async () => {
    const res = await put(platformToken, { id: locId(storeA2.id), managerName: 'W3R Put Regression' })
    expect(res.status).toBe(200)
    expect(res.body.message).toBe('Store configuration updated successfully.')
    expect(Object.keys(res.body.data).sort()).toEqual([...BASE_PROJECTION_KEYS].sort())
    for (const field of CONFIG_FIELDS) expect(res.body.data[field]).toBeUndefined()
  })

  test('legacy GET detail carries the configuration fields with its authorization unchanged', async () => {
    const res = await request(app)
      .get(`/location/get-location-detail/${projectedId(storeA1.id)}`)
      .set('Authorization', `Bearer ${platformToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.timezone).toBe('Asia/Makassar')
    expect(res.body.data.description).toBe('W3R configured store')
    expect(Number(res.body.data.maxActiveParkedCarts)).toBe(7)
    expect(Number(res.body.data.parkedCartTtlMinutes)).toBe(45)
  })
})
