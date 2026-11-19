process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 4 — Objective A.
//
// F21-05: ingredient.js getAll applied `lowStock=true` in JavaScript AFTER
// the DB already paginated (limit/offset), so a low-stock ingredient
// outside the raw page window was invisible, and `pagination.total` was
// silently just "how many of THIS page happened to qualify" rather than a
// true total.
//
// F21-06: pos.js getSuperAdminDashboard's ingredient low-stock query was
// the ONE outlier requiring `minStock > 0`, while every other ingredient
// low-stock implementation in the codebase (ingredient.js getAll,
// stockHistory.js getLowStock/getLowStockAll/autoGeneratePO, and pos.js
// getDashboardSummary's own ingredient count) consistently uses the
// unguarded `stock <= minStock` — an ingredient with stock=0, minStock=0
// counted on every one of those except the super-admin dashboard detail
// list, which silently dropped it.

let storeA = null
let adminA = null
let tokenA = null
let superToken = null

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'LOWSTOCK_STORE_A', status: 'active' }))

  adminA = await db.user.create({
    userName: 'admin_lowstock_a',
    email: 'admin_lowstock_a@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active'
  })


  // P1-4: central gate denies unknown caller identities; this row gives the
  // super token id a real identity (adminA row already exists above).
  // Assertions below are unchanged.
  await db.user.create({
    id: 9990,
    userName: 'super_lowstock',
    email: 'p14-9990-lowstock@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'super_lowstock'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  tokenA = await signSessionToken(
    { id: adminA.id, userName: adminA.userName, roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
  superToken = await signSessionToken({ id: 9990, userName: 'super_lowstock', roleType: 'super_admin' }, JWT_SECRET)
})

afterAll(async () => {
  await db.ingredient.destroy({ where: { store: storeA.id }, force: true })
  await db.user.destroy({ where: { id: [adminA?.id, 9990].filter(Boolean) }, force: true })
  await db.location.destroy({ where: { id: storeA?.id }, force: true })
})

const makeIngredient = (overrides = {}) =>
  db.ingredient.create({
    store: storeA.id,
    unit: 'pcs',
    baseUnit: 'pcs',
    conversionFactor: 1,
    status: 'active',
    ...overrides
  })

describe('F21-05 — ingredient low-stock pagination', () => {
  let lowStockIngredient = null

  beforeAll(async () => {
    // Created first (oldest updatedAt) — a naive "paginate first, filter
    // after" implementation ordered by updatedAt DESC will push this
    // ingredient PAST a small page unless the low-stock condition is
    // applied at the DB layer before LIMIT/OFFSET.
    lowStockIngredient = await makeIngredient({
      name: 'LOWSTOCK_PAG_TARGET',
      stock: 1,
      minStock: 5
    })
    // Three ingredients created afterward (more recent updatedAt), all
    // well-stocked — these occupy the first page under updatedAt DESC
    // ordering with limit=2.
    for (let i = 0; i < 3; i += 1) {
      await makeIngredient({
        name: `LOWSTOCK_PAG_FILLER_${i}`,
        stock: 100,
        minStock: 5
      })
    }
  })

  test('a low-stock ingredient outside the raw first page is still returned', async () => {
    const res = await request(app)
      .get('/ingredient/get-all')
      .query({ lowStock: 'true', limit: 2, page: 1 })
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.map((i) => i.id)
    expect(ids).toContain(lowStockIngredient.id)
  })

  test('pagination.total reflects the true count of low-stock ingredients, not the page size', async () => {
    const res = await request(app)
      .get('/ingredient/get-all')
      .query({ lowStock: 'true', limit: 2, page: 1 })
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)
    // Exactly one ingredient in this store matches stock<=minStock.
    expect(res.body.pagination.total).toBe(1)
    expect(res.body.totalItems).toBe(1)
  })
})

describe('F21-06 — low-stock count/list consistency (minStock=0 edge case)', () => {
  let ingredientNoThreshold = null
  let ingredientWithThreshold = null

  beforeAll(async () => {
    ingredientNoThreshold = await makeIngredient({
      name: 'LOWSTOCK_CONSISTENCY_NO_THRESHOLD',
      stock: 0,
      minStock: 0
    })
    ingredientWithThreshold = await makeIngredient({
      name: 'LOWSTOCK_CONSISTENCY_WITH_THRESHOLD',
      stock: 0,
      minStock: 5
    })
  })

  test('the ingredient list (lowStock=true) counts both the guarded and unguarded case', async () => {
    const res = await request(app)
      .get('/ingredient/get-all')
      .query({ lowStock: 'true', limit: 50 })
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.map((i) => i.id)
    expect(ids).toContain(ingredientNoThreshold.id)
    expect(ids).toContain(ingredientWithThreshold.id)
  })

  test('the per-store dashboard summary low-stock count agrees with the ingredient list total', async () => {
    const listRes = await request(app)
      .get('/ingredient/get-all')
      .query({ lowStock: 'true', limit: 50 })
      .set('Authorization', `Bearer ${tokenA}`)
    expect(listRes.status).toBe(200)

    const dashRes = await request(app)
      .get('/pos/dashboard/summary')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(dashRes.status).toBe(200)

    // Both must count the same set of ingredients under the same store
    // scope — the dashboard's lowStock figure includes products too, but
    // it must not be LOWER than the ingredient-only total (it was, before
    // the fix, because ingredientNoThreshold with minStock=0 disagreement
    // was never the cause here — this specific endpoint already had no
    // guard; this assertion pins that non-regression).
    expect(dashRes.body.data.lowStock).toBeGreaterThanOrEqual(listRes.body.pagination.total)
  })

  test('the super_admin dashboard low-stock detail list agrees with the ingredient list definition', async () => {
    const listRes = await request(app)
      .get('/ingredient/get-all')
      .query({ lowStock: 'true', limit: 50 })
      .set('Authorization', `Bearer ${tokenA}`)
    expect(listRes.status).toBe(200)
    const listIds = listRes.body.data.map((i) => i.id).sort()

    const superRes = await request(app)
      .get('/pos/dashboard/super-admin')
      .query({ store: storeA.id })
      .set('Authorization', `Bearer ${superToken}`)
    expect(superRes.status).toBe(200)

    const ingredientLowStockIds = superRes.body.data.operations.lowStockItems
      .filter((item) => item.type === 'ingredient')
      .map((item) => item.id)
      .sort()

    // Both of this test's fixtures (including the minStock=0 one) must
    // appear in the super-admin dashboard's own ingredient low-stock
    // detail list, matching the same unguarded definition the ingredient
    // list endpoint uses.
    expect(ingredientLowStockIds).toEqual(expect.arrayContaining(listIds))
  })
})

describe('F21-05/F21-06 — store isolation preserved', () => {
  test('a store-A-only admin still only ever sees store A ingredients in the low-stock list', async () => {
    const res = await request(app)
      .get('/ingredient/get-all')
      .query({ lowStock: 'true', limit: 50 })
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)
    const stores = res.body.data.map((i) => i.store).filter((s) => s !== null)
    stores.forEach((s) => expect(Number(s)).toBe(storeA.id))
  })
})
