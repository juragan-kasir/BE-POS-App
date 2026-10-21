process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Regression suite for the reported supplier visibility defect (2026-10-21).
//
// Reported scenario: a supplier created by a store-bound super_admin
// (bakso_admin: roleType='super_admin', users.store = N) with a specific store
// selected does not appear under the FE "All Stores" filter, but does appear
// under that store's filter.
//
// Root cause: api/controller/supplier.js:408 read the filter as
//   const store = req.query.store || req.user?.store
// The FE sends `store=` (empty) for "All Stores" (services/supplier.js:8), so the
// empty string fell through to the ACCOUNT's own store and the query became
// `store @> [ownStore]`. The "All Stores" control was therefore a no-op.
//
// The fix stops substituting the account's own store for an explicitly empty
// filter. These tests pin the contract for BOTH super_admin variants and for
// the non-super_admin path, and guard the tenant/store boundary.
//
// CONTRACT PINNED HERE
//   super_admin (global,     users.store IS NULL): no filter -> every supplier
//   super_admin (store-bound, users.store = N)  : no filter -> every supplier
//   non-super_admin (users.store = N)            : no filter -> own store + global
//   any super_admin           : ?store=X         -> store X + global
//   non-super_admin           : ?store=X (≠ own) -> 403
//
// Rationale for treating both super_admin variants alike on READ: the BA
// documents a store-bound super_admin as "unrestricted elsewhere"
// (POS-MASTER-BUSINESS-ANALYSIS.md §6), and DR-02 — which would split the two
// variants into Platform vs Tenant Administrator — is DECIDED but NOT
// IMPLEMENTED. Store confinement for a store-bound super_admin is therefore a
// separate change (DR-02 implementation), not a side effect of this fix.

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Fixed high ids so this suite never collides with other suites' fixtures.
const U_STORE_BOUND = 89701
const U_GLOBAL = 89702
const U_TENANT_ADMIN = 89703

let storeA, storeB, storeC
let storeBoundToken, globalToken, tenantAdminToken

const name = (tag) => `SUPVIS_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

describe('Supplier list store scope — "All Stores" must not degrade to the caller own store', () => {
  beforeAll(async () => {
    storeA = await db.location.create({ name: name('STORE_A'), status: 'active' })
    storeB = await db.location.create({ name: name('STORE_B'), status: 'active' })
    storeC = await db.location.create({ name: name('STORE_C'), status: 'active' })

    await db.user.create({
      id: U_STORE_BOUND,
      userName: name('storebound_super'),
      email: 'supvis-storebound@test.com',
      roleType: 'super_admin',
      userType: 'admin',
      store: storeA.id, // store-bound super_admin — the reported account shape
      status: 'active',
      fullName: 'store bound super admin'
    })
    await db.user.create({
      id: U_GLOBAL,
      userName: name('global_super'),
      email: 'supvis-global@test.com',
      roleType: 'super_admin',
      userType: 'super_admin',
      store: null, // global super_admin
      status: 'active',
      fullName: 'global super admin'
    })
    await db.user.create({
      id: U_TENANT_ADMIN,
      userName: name('tenant_admin'),
      email: 'supvis-tenant@test.com',
      roleType: 'admin',
      userType: 'admin',
      store: storeA.id,
      status: 'active',
      fullName: 'tenant admin'
    })

    storeBoundToken = await signSessionToken(
      { id: U_STORE_BOUND, userName: 'storebound', roleType: 'super_admin', store: storeA.id },
      JWT_SECRET
    )
    globalToken = await signSessionToken(
      { id: U_GLOBAL, userName: 'globalsuper', roleType: 'super_admin', store: null },
      JWT_SECRET
    )
    tenantAdminToken = await signSessionToken(
      { id: U_TENANT_ADMIN, userName: 'tenantadmin', roleType: 'admin', store: storeA.id },
      JWT_SECRET
    )
  })

  afterAll(async () => {
    await db.supplier.destroy({ where: { name: { [require('sequelize').Op.like]: 'SUPVIS_%' } }, force: true })
    await db.user.destroy({ where: { id: [U_STORE_BOUND, U_GLOBAL, U_TENANT_ADMIN] }, force: true })
    await db.location.destroy({ where: { id: [storeA.id, storeB.id, storeC.id] }, force: true })
  })

  // Create one supplier per store, plus one global (unassigned) supplier.
  let supA, supB, supC, supGlobal
  beforeAll(async () => {
    supA = await db.supplier.create({ name: name('SUP_A'), store: [storeA.id], status: 'active' })
    supB = await db.supplier.create({ name: name('SUP_B'), store: [storeB.id], status: 'active' })
    supC = await db.supplier.create({ name: name('SUP_C'), store: [storeC.id], status: 'active' })
    supGlobal = await db.supplier.create({ name: name('SUP_GLOBAL'), store: [], status: 'active' })
  })

  afterAll(async () => {
    await db.supplier.destroy({ where: { id: [supA.id, supB.id, supC.id, supGlobal.id] }, force: true })
  })

  const listNames = async (res) => (res.body?.data || []).map((s) => s.name)

  // ---------------------------------------------------------------------
  // The reported defect
  // ---------------------------------------------------------------------
  test('store-bound super_admin: "All Stores" (no store param) returns EVERY supplier, not only its own store', async () => {
    const res = await request(app)
      .get('/supplier')
      .set('Authorization', `Bearer ${storeBoundToken}`)
      .query({ page: 1, limit: 100 })

    expect(res.status).toBe(200)
    const names = await listNames(res)
    expect(names).toEqual(expect.arrayContaining([supA.name, supB.name, supC.name, supGlobal.name]))
  })

  test('store-bound super_admin: "All Stores" as an EMPTY store param returns EVERY supplier (the FE sends store=)', async () => {
    // FE src/services/supplier.js:8 always emits `store=` in the URL.
    const res = await request(app)
      .get('/supplier')
      .set('Authorization', `Bearer ${storeBoundToken}`)
      .query({ page: 1, limit: 100, store: '' })

    expect(res.status).toBe(200)
    const names = await listNames(res)
    expect(names).toEqual(expect.arrayContaining([supA.name, supB.name, supC.name, supGlobal.name]))
  })

  // ---------------------------------------------------------------------
  // Account parity — both super_admin variants must behave identically
  // ---------------------------------------------------------------------
  test('global super_admin and store-bound super_admin return the SAME result set for "All Stores"', async () => {
    const [g, sb] = await Promise.all([
      request(app).get('/supplier').set('Authorization', `Bearer ${globalToken}`).query({ page: 1, limit: 100 }),
      request(app).get('/supplier').set('Authorization', `Bearer ${storeBoundToken}`).query({ page: 1, limit: 100 })
    ])
    expect(g.status).toBe(200)
    expect(sb.status).toBe(200)
    expect((await listNames(sb)).sort()).toEqual((await listNames(g)).sort())
  })

  // ---------------------------------------------------------------------
  // An explicit store filter still narrows
  // ---------------------------------------------------------------------
  test('super_admin: an explicit store filter narrows to that store plus global suppliers', async () => {
    const res = await request(app)
      .get('/supplier')
      .set('Authorization', `Bearer ${storeBoundToken}`)
      .query({ page: 1, limit: 100, store: String(storeB.id) })

    expect(res.status).toBe(200)
    const names = await listNames(res)
    expect(names).toContain(supB.name)
    expect(names).toContain(supGlobal.name) // global rows stay visible
    expect(names).not.toContain(supA.name)
    expect(names).not.toContain(supC.name)
  })

  // ---------------------------------------------------------------------
  // Non-super_admin keeps its store confinement
  // ---------------------------------------------------------------------
  test('non-super_admin: no store param returns own store + global suppliers only', async () => {
    const res = await request(app)
      .get('/supplier')
      .set('Authorization', `Bearer ${tenantAdminToken}`)
      .query({ page: 1, limit: 100 })

    expect(res.status).toBe(200)
    const names = await listNames(res)
    expect(names).toContain(supA.name)
    expect(names).toContain(supGlobal.name)
    expect(names).not.toContain(supB.name)
    expect(names).not.toContain(supC.name)
  })

  test('non-super_admin: a foreign store filter is refused (403) — not a visibility leak', async () => {
    const res = await request(app)
      .get('/supplier')
      .set('Authorization', `Bearer ${tenantAdminToken}`)
      .query({ page: 1, limit: 100, store: String(storeB.id) })

    expect(res.status).toBe(403)
  })

  // ---------------------------------------------------------------------
  // Parameter robustness — an empty/absent/invalid filter must not widen
  // the non-super_admin scope, and must not produce a NaN predicate.
  // ---------------------------------------------------------------------
  test.each([
    ['absent', undefined],
    ['empty string', ''],
    ['null', 'null'],
    ['non-numeric', 'abc'],
    ['"all"', 'all']
  ])('non-super_admin: store filter %s does not widen the visible set', async (_label, value) => {
    const query = { page: 1, limit: 100 }
    if (value !== undefined) query.store = value

    const res = await request(app)
      .get('/supplier')
      .set('Authorization', `Bearer ${tenantAdminToken}`)
      .query(query)

    expect(res.status).toBe(200)
    const names = await listNames(res)
    expect(names).toContain(supA.name)
    expect(names).toContain(supGlobal.name)
    expect(names).not.toContain(supB.name)
    expect(names).not.toContain(supC.name)
  })

  // ---------------------------------------------------------------------
  // A supplier created through the API by the store-bound super_admin with a
  // specific store MUST be visible to it under "All Stores" (the exact BA
  // reproduction steps 3-6).
  // ---------------------------------------------------------------------
  test('reproduction: a supplier created by a store-bound super_admin for a specific store shows up under "All Stores"', async () => {
    const created = await request(app)
      .post('/supplier')
      .set('Authorization', `Bearer ${storeBoundToken}`)
      .send({ name: name('REPRO'), phone: '0800000000', store: [storeB.id], status: 'active' })

    expect({ status: created.status, body: created.body }).toMatchObject({ status: 201 })
    const createdId = created.body?.data?.id
    expect(createdId).toBeTruthy()
    expect(created.body?.data?.store).toEqual([storeB.id])

    const all = await request(app)
      .get('/supplier')
      .set('Authorization', `Bearer ${storeBoundToken}`)
      .query({ page: 1, limit: 100, store: '' })
    expect(all.status).toBe(200)
    expect(await listNames(all)).toContain(created.body.data.name)

    const scoped = await request(app)
      .get('/supplier')
      .set('Authorization', `Bearer ${storeBoundToken}`)
      .query({ page: 1, limit: 100, store: String(storeB.id) })
    expect(scoped.status).toBe(200)
    expect(await listNames(scoped)).toContain(created.body.data.name)
  })

  // ---------------------------------------------------------------------
  // Pagination / search / refresh must not hide a record
  // ---------------------------------------------------------------------
  test('a supplier beyond the first page is still reachable via pagination', async () => {
    const page1 = await request(app)
      .get('/supplier')
      .set('Authorization', `Bearer ${storeBoundToken}`)
      .query({ page: 1, limit: 1 })
    expect(page1.status).toBe(200)
    expect(page1.body?.data?.length).toBe(1)

    const seen = new Set()
    for (let p = 1; p <= 10; p++) {
      const res = await request(app)
        .get('/supplier')
        .set('Authorization', `Bearer ${storeBoundToken}`)
        .query({ page: p, limit: 1 })
      if (res.status !== 200) break
      for (const n of await listNames(res)) seen.add(n)
      if ((res.body?.data || []).length === 0) break
    }
    expect(seen).toContain(supA.name)
    expect(seen).toContain(supB.name)
  })

  test('search narrows without dropping the match', async () => {
    const res = await request(app)
      .get('/supplier')
      .set('Authorization', `Bearer ${storeBoundToken}`)
      .query({ page: 1, limit: 100, search: supB.name })

    expect(res.status).toBe(200)
    expect(await listNames(res)).toContain(supB.name)
  })
})
