process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// N-11 regression — global fail-open for unassigned accounts.
//
// Before this fix, a non-super-admin token that carried NO numeric `store`
// claim fell through every `req.storeId || req.cookies.store ||
// req.query.store || req.user?.store` chain into attacker-controlled cookie /
// query / body values, silently granting cross-tenant access. The fixes:
//
// 1. validateStoreAccess now FAILS CLOSED (403 'Store assignment required')
//    for any non-super-admin account without a real store claim — no client
//    cookie/query/body can resurrect an unassigned account.
// 2. Controllers resolve the effective store via `resolveStoreId(req)`:
//    super_admin keeps the explicit store selector (global behavior), while
//    everyone else is pinned to req.storeId / the JWT claim and NEVER reads a
//    client-controlled cookie/query/body store.
//
// These tests drive the real routes (superagent + cookie forgery) and assert
// response content + DB rows, not just statuses.

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA = null
let storeB = null
let currencyA = null
let currencyB = null

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'N11_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'N11_STORE_B', status: 'active' }))
  currencyA = await db.currency.create({
    store: storeA.id,
    code: 'N11-A',
    name: 'N11 Currency A',
    symbol: 'A',
    exchangeRate: 1,
    status: 'active'
  })
  currencyB = await db.currency.create({
    store: storeB.id,
    code: 'N11-B',
    name: 'N11 Currency B',
    symbol: 'B',
    exchangeRate: 1,
    status: 'active'
  })

  // P1-4: central gate denies unknown caller identities. These rows give the
  // deterministic token identities below real rows with matching
  // unassigned/assigned semantics (store null = unassigned). Assertions
  // below are unchanged.
  await db.user.create({
    id: 79111,
    userName: 'n11_admin_unassigned',
    email: 'p14-79111-n11@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'n11_admin_unassigned'
  })
  await db.user.create({
    id: 79112,
    userName: 'n11_admin_a',
    email: 'p14-79112-n11@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active',
    fullName: 'n11_admin_a'
  })
  await db.user.create({
    id: 79113,
    userName: 'n11_super',
    email: 'p14-79113-n11@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'n11_super'
  })
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [79111, 79112, 79113] }, force: true })
  await db.currency.destroy({ where: { id: [currencyA.id, currencyB.id] }, force: true })
  await db.location.destroy({ where: { id: [storeA.id, storeB.id] }, force: true })
})

const tokenFor = (roleType, store) =>
  signSessionToken(
    {
      // Deterministic ids matching the caller rows above (P1-4 identity
      // invariant); unassigned callers keep no store claim.
      id:
        roleType === 'super_admin' ? 79113 : store != null ? 79112 : 79111,
      userName: `n11_${roleType}`,
      roleType,
      ...(store != null ? { store } : {})
    },
    JWT_SECRET
  )

const listCurrencies = (token, { query = {}, cookieStore } = {}) => {
  let req = request(app).get('/currency').query(query)
  if (cookieStore != null) req = req.set('Cookie', [`store=${cookieStore}`])
  return req.set('Authorization', `Bearer ${token}`)
}

describe('N-11 unassigned-account fail-open is closed', () => {
  test('unassigned admin gets 403 even with a forged store cookie and ?store=', async () => {
    const unassignedToken = await tokenFor('admin')
    const res = await listCurrencies(unassignedToken, {
      query: { store: storeB.id },
      cookieStore: storeB.id
    })
    expect(res.status).toBe(403)
    expect(res.body.data).toBeUndefined()
  })

  test('plain unassigned admin (no claims at all) is rejected with the store-required guard', async () => {
    const unassignedToken = await tokenFor('admin')
    const res = await listCurrencies(unassignedToken)
    expect(res.status).toBe(403)
    expect(res.body.message).toBe('Store assignment required')
  })

  test('unassigned admin gets 403 on a second scoped controller (expense list too)', async () => {
    const unassignedToken = await tokenFor('admin')
    const res = await request(app)
      .get('/expense/get-all')
      .set('Authorization', `Bearer ${unassignedToken}`)
      .set('Cookie', [`store=${storeB.id}`])
    expect(res.status).toBe(403)
  })

  test('assigned admin claiming a DIFFERENT store in ?store= is 403 (middleware rejects the conflict)', async () => {
    const adminA = await tokenFor('admin', storeA.id)
    const res = await listCurrencies(adminA, {
      query: { store: storeB.id },
      cookieStore: storeB.id
    })
    expect(res.status).toBe(403)
    expect(res.body.data).toBeUndefined()
  })

  test('assigned admin with a forged store cookie (no query) is still pinned to store A', async () => {
    const adminA = await tokenFor('admin', storeA.id)
    const res = await listCurrencies(adminA, { cookieStore: storeB.id })
    expect(res.status).toBe(200)
    const rows = res.body.data || res.body.currencies || []
    const codes = Array.isArray(rows) ? rows.map((r) => r.code) : []
    expect(codes).toContain('N11-A')
    expect(codes).not.toContain('N11-B')
  })

  test('super_admin WITHOUT a store claim keeps the global unscoped view (both stores)', async () => {
    const superToken = await tokenFor('super_admin')
    const res = await listCurrencies(superToken)
    expect(res.status).toBe(200)
    const rows = res.body.data || res.body.currencies || []
    const codes = Array.isArray(rows) ? rows.map((r) => r.code) : []
    expect(codes).toContain('N11-A')
    expect(codes).toContain('N11-B')
  })

  test('super_admin store selector ?store=B returns only store B rows (global override preserved)', async () => {
    const superToken = await tokenFor('super_admin')
    const res = await listCurrencies(superToken, { query: { store: storeB.id } })
    expect(res.status).toBe(200)
    const rows = res.body.data || res.body.currencies || []
    const codes = Array.isArray(rows) ? rows.map((r) => r.code) : []
    expect(codes).toContain('N11-B')
    expect(codes).not.toContain('N11-A')
  })
})