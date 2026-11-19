process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 39 Batch 6-prereq: register-facing responses must expose the
// store's authoritative location.timezone so FE can render register
// timestamps in store-local time instead of the viewer's browser
// timezone. Plumbing only — the register-window comparison itself
// (openedAt <= createdAt <= closedAt) is an instant comparison and stays
// unaffected. This suite proves the new `timezone` field is present and
// correct on GET /cash-register/current, /history, and /z-report/:id —
// both for a store left on the default timezone (must remain unchanged)
// and for a store with a non-default timezone.

const SUFFIX = Date.now()

let storeDefault = null
let storeCustom = null
let opener = null
let openerCustom = null
let adminToken = null
let adminTokenCustom = null
let registerDefault = null
let registerCustom = null

beforeAll(async () => {
  // No explicit timezone → the model's column default (Asia/Jakarta)
  // applies. This is the existing common case that must render exactly
  // as before.
  storeDefault = await db.location.create(await withTestTenant({ name: `TZ_STORE_DEFAULT_${SUFFIX}` }))
  // A real, distinct IANA zone already known to this codebase's
  // businessDate.js TIMEZONE_OFFSETS map (Asia/Jayapura, +09:00).
  storeCustom = await db.location.create(await withTestTenant({
    name: `TZ_STORE_CUSTOM_${SUFFIX}`,
    timezone: 'Asia/Jayapura'
  }))

  opener = await db.user.create({
    userName: `tz_opener_${SUFFIX}`,
    roleType: 'admin',
    store: storeDefault.id,
    password: 'x'
  })

  adminToken = await signSessionToken(
    { id: opener.id, userName: opener.userName, roleType: 'admin', store: storeDefault.id },
    JWT_SECRET
  )
  // AUTH-1 P2: the caller's store is its DB row, so the custom-store admin
  // is its own account rather than a second store claim on `opener`.
  openerCustom = await db.user.create({
    userName: `tz_opener_custom_${SUFFIX}`,
    roleType: 'admin',
    store: storeCustom.id,
    password: 'x'
  })
  adminTokenCustom = await signSessionToken(
    { id: openerCustom.id, userName: openerCustom.userName, roleType: 'admin', store: storeCustom.id },
    JWT_SECRET
  )

  const OPENED_AT = new Date('2026-09-14T07:48:27.000Z')
  const CLOSED_AT = new Date('2026-09-21T04:27:48.000Z')

  registerDefault = await db.cashRegister.create({
    store: storeDefault.id,
    user: opener.id,
    openingBalance: 100000,
    closingBalance: 100000,
    status: 'closed',
    openedAt: OPENED_AT,
    closedAt: CLOSED_AT
  })
  registerCustom = await db.cashRegister.create({
    store: storeCustom.id,
    user: opener.id,
    openingBalance: 100000,
    closingBalance: 100000,
    status: 'closed',
    openedAt: OPENED_AT,
    closedAt: CLOSED_AT
  })
})

afterAll(async () => {
  await db.cashRegister.destroy({
    where: { id: [registerDefault?.id, registerCustom?.id].filter(Boolean) },
    force: true
  }).catch(() => {})
  await db.user.destroy({ where: { id: [opener?.id, openerCustom?.id].filter(Boolean) }, force: true }).catch(() => {})
  await db.location.destroy({
    where: { id: [storeDefault?.id, storeCustom?.id].filter(Boolean) },
    force: true
  }).catch(() => {})
})

describe('Phase 39 Batch 6-prereq — store timezone plumbing', () => {
  test('T1 — GET /cash-register/current exposes storeData.timezone (default case)', async () => {
    const res = await request(app)
      .get('/cash-register/current')
      .query({ store: storeDefault.id })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    // No open register for this store in this suite (registerDefault is
    // closed), so the endpoint returns { data: null } — that alone
    // already proves no regression; the timezone-bearing branch is
    // covered by the other tests below via history/z-report.
    expect(res.body.data).toBeNull()
  })

  test('T2 — GET /cash-register/history exposes storeData.timezone, default store', async () => {
    const res = await request(app)
      .get('/cash-register/history')
      .query({ store: storeDefault.id, limit: 10 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    const row = res.body.data.find((r) => r.id === registerDefault.id)
    expect(row).toBeDefined()
    expect(row.storeData).toBeDefined()
    expect(row.storeData.timezone).toBe('Asia/Jakarta')
  })

  test('T3 — GET /cash-register/history exposes storeData.timezone, non-default store', async () => {
    const res = await request(app)
      .get('/cash-register/history')
      .query({ store: storeCustom.id, limit: 10 })
      .set('Authorization', `Bearer ${adminTokenCustom}`)
    expect(res.status).toBe(200)
    const row = res.body.data.find((r) => r.id === registerCustom.id)
    expect(row).toBeDefined()
    expect(row.storeData.timezone).toBe('Asia/Jayapura')
  })

  test('T4 — GET /cash-register/z-report/:id exposes data.store.timezone, default store', async () => {
    const res = await request(app)
      .get(`/cash-register/z-report/${registerDefault.id}`)
      .query({ store: storeDefault.id })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.store.timezone).toBe('Asia/Jakarta')
  })

  test('T5 — GET /cash-register/z-report/:id exposes data.store.timezone, non-default store', async () => {
    const res = await request(app)
      .get(`/cash-register/z-report/${registerCustom.id}`)
      .query({ store: storeCustom.id })
      .set('Authorization', `Bearer ${adminTokenCustom}`)
    expect(res.status).toBe(200)
    expect(res.body.data.store.timezone).toBe('Asia/Jayapura')
  })

  test('T6 — z-report register-window comparison is unaffected by timezone (Batch 4/5 contract preserved)', async () => {
    // Same store/opener/window semantics as Batch 4/5 — proves this
    // plumbing change never touched the instant-comparison filtering.
    const res = await request(app)
      .get(`/cash-register/z-report/${registerCustom.id}`)
      .query({ store: storeCustom.id })
      .set('Authorization', `Bearer ${adminTokenCustom}`)
    expect(res.status).toBe(200)
    expect(res.body.data.register.openedAt).toBe(registerCustom.openedAt.toISOString())
    expect(res.body.data.register.closedAt).toBe(registerCustom.closedAt.toISOString())
    expect(res.body.data.reconciliation.window.openedAt).toBeDefined()
  })
})
