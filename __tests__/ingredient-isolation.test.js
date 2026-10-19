process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken, ensureLocationIds } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const ingredientController = require('../api/controller/ingredient')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Users
let superAdminToken

let adminStore1Token

let adminStore2Token

let ingStore1 = null
let ingStore2 = null

beforeAll(async () => {
  // AUTH-1 P2: the caller store comes from the DB row; abstract stores must exist.
  await ensureLocationIds(1, 2)
  ingStore1 = await db.ingredient.create({
    store: 1,
    name: 'TEST_ISOLATION_STORE1',
    stock: 10,
    minStock: 2,
    unit: 'pcs',
    baseUnit: 'pcs',
    conversionFactor: 1,
    status: 'active'
  })

  ingStore2 = await db.ingredient.create({
    store: 2,
    name: 'TEST_ISOLATION_STORE2',
    stock: 20,
    minStock: 5,
    unit: 'pcs',
    baseUnit: 'pcs',
    conversionFactor: 1,
    status: 'active'
  })

  // P1-4: central gate denies unknown caller identities; these rows satisfy
  // the identity invariant. JWT claims (abstract store numbers) and all
  // assertions are unchanged; row store stays null (no FK implication).
  await db.user.create({
    id: 9999,
    userName: 'superadmin',
    email: 'p14-9999-ingredient-isolation@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'superadmin'
  })
  await db.user.create({
    id: 9998,
    userName: 'admin1',
    email: 'p14-9998-ingredient-isolation@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: 1,
    status: 'active',
    fullName: 'admin1'
  })
  await db.user.create({
    id: 9997,
    userName: 'admin2',
    email: 'p14-9997-ingredient-isolation@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: 2,
    status: 'active',
    fullName: 'admin2'
  })
})

// AUTH-1 P2: tokens bound to real sessions, minted once the users exist.
beforeAll(async () => {
  superAdminToken = await signSessionToken(
  { id: 9999, userName: 'superadmin', roleType: 'super_admin' },
  JWT_SECRET
)
  adminStore1Token = await signSessionToken(
  { id: 9998, userName: 'admin1', roleType: 'admin', store: 1 },
  JWT_SECRET
)
  adminStore2Token = await signSessionToken(
  { id: 9997, userName: 'admin2', roleType: 'admin', store: 2 },
  JWT_SECRET
)
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [9999, 9998, 9997] }, force: true })
  const ids = []
  if (ingStore1) ids.push(ingStore1.id)
  if (ingStore2) ids.push(ingStore2.id)
  if (ids.length > 0) {
    // adjust-stock ledger rows reference the ingredient (FK) — remove first
    await db.stock_history.destroy({ where: { ingredient: ids }, force: true })
    await db.ingredient.destroy({ where: { id: ids }, force: true })
  }
})

// ===================== GET ALL =====================
describe('GET /ingredient/get-all — data isolation', () => {
  test('super_admin sees ingredients from all stores', async () => {
    const res = await request(app)
      .get('/ingredient/get-all')
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(res.status).toBe(200)
    const names = res.body.data.map((i) => i.name)
    expect(names).toContain('TEST_ISOLATION_STORE1')
    expect(names).toContain('TEST_ISOLATION_STORE2')
  })

  test('admin store 1 only sees store 1 ingredients', async () => {
    const res = await request(app)
      .get('/ingredient/get-all')
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const names = res.body.data.map((i) => i.name)
    expect(names).toContain('TEST_ISOLATION_STORE1')
    expect(names).not.toContain('TEST_ISOLATION_STORE2')
  })

  test('admin store 1 cannot access store 2 via ?store= param', async () => {
    const res = await request(app)
      .get('/ingredient/get-all?store=2')
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(403)
  })

  test('admin store 2 only sees store 2 ingredients', async () => {
    const res = await request(app)
      .get('/ingredient/get-all')
      .set('Authorization', `Bearer ${adminStore2Token}`)

    expect(res.status).toBe(200)
    const names = res.body.data.map((i) => i.name)
    expect(names).not.toContain('TEST_ISOLATION_STORE1')
    expect(names).toContain('TEST_ISOLATION_STORE2')
  })
})

// ===================== GET BY ID =====================
describe('GET /ingredient/get-by-id/:id — data isolation', () => {
  test('admin store 1 cannot get store 2 ingredient by id', async () => {
    const res = await request(app)
      .get(`/ingredient/get-by-id/${ingStore2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    expect(res.body.message).toMatch(/not found/i)
  })

  test('admin store 1 can get own ingredient by id', async () => {
    const res = await request(app)
      .get(`/ingredient/get-by-id/${ingStore1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('TEST_ISOLATION_STORE1')
  })

  test('super_admin can get any store ingredient by id', async () => {
    const res = await request(app)
      .get(`/ingredient/get-by-id/${ingStore2.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('TEST_ISOLATION_STORE2')
  })
})

// ===================== UPDATE =====================
describe('PUT /ingredient/edit/:id — data isolation', () => {
  test('admin store 1 cannot update store 2 ingredient', async () => {
    const res = await request(app)
      .put(`/ingredient/edit/${ingStore2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'TEST_HACKED' })

    expect(res.status).toBe(404)
  })

  test('admin store 1 can update own ingredient', async () => {
    const res = await request(app)
      .put(`/ingredient/edit/${ingStore1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'TEST_ISOLATION_STORE1_UPDATED' })

    expect(res.status).toBe(200)

    await ingStore1.reload()
    expect(ingStore1.name).toBe('TEST_ISOLATION_STORE1_UPDATED')

    await ingStore1.update({ name: 'TEST_ISOLATION_STORE1' })
  })
})

// ===================== DELETE =====================
describe('DELETE /ingredient/delete/:id — data isolation', () => {
  test('admin store 1 cannot delete store 2 ingredient', async () => {
    const res = await request(app)
      .delete(`/ingredient/delete/${ingStore2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)

    const stillExists = await db.ingredient.findByPk(ingStore2.id)
    expect(stillExists).not.toBeNull()
  })

  test('admin store 1 can delete own ingredient', async () => {
    const res = await request(app)
      .delete(`/ingredient/delete/${ingStore1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)

    const deleted = await db.ingredient.findByPk(ingStore1.id)
    expect(deleted).toBeNull()

    ingStore1 = await db.ingredient.create({
      store: 1,
      name: 'TEST_ISOLATION_STORE1',
      stock: 10,
      minStock: 2,
      unit: 'pcs',
      baseUnit: 'pcs',
      conversionFactor: 1,
      status: 'active'
    })
  })
})

// ===================== ADJUST STOCK =====================
describe('PUT /ingredient/adjust-stock/:id — data isolation', () => {
  test('admin store 1 cannot adjust stock of store 2 ingredient', async () => {
    const res = await request(app)
      .put(`/ingredient/adjust-stock/${ingStore2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ quantity: 5, type: 'add' })

    expect(res.status).toBe(404)

    const unchanged = await db.ingredient.findByPk(ingStore2.id)
    expect(Number(unchanged.stock)).toBe(20)
  })

  test('admin store 1 can adjust stock of own ingredient', async () => {
    const res = await request(app)
      .put(`/ingredient/adjust-stock/${ingStore1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ quantity: 5, type: 'add' })

    expect(res.status).toBe(200)

    await ingStore1.reload()
    expect(Number(ingStore1.stock)).toBe(15)

    await ingStore1.update({ stock: 10 })
  })
})

// ===================== CREATE =====================
describe('POST /ingredient/add — data isolation', () => {
  test('admin store 1 cannot create ingredient for store 2 (middleware blocks)', async () => {
    const res = await request(app)
      .post('/ingredient/add')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'TEST_ISOLATION_HACK', store: '2', status: 'active' })

    expect(res.status).toBe(403)
  })

  test('admin store 1 can create ingredient for own store', async () => {
    const res = await request(app)
      .post('/ingredient/add')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'TEST_ISOLATION_CREATE', status: 'active' })

    expect(res.status).toBe(201)
    expect(res.body.data.store).toBe(1)

    await db.ingredient.destroy({
      where: { id: res.body.data.id },
      force: true
    })
  })

  test('super_admin can create ingredient for any store', async () => {
    const res = await request(app)
      .post('/ingredient/add')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'TEST_ISOLATION_SUPER_CREATE', store: '2', status: 'active' })

    expect(res.status).toBe(201)
    expect(res.body.data.store).toBe(2)

    await db.ingredient.destroy({
      where: { id: res.body.data.id },
      force: true
    })
  })
})

// ===================== UNAUTHENTICATED =====================
describe('Unauthenticated access', () => {
  test('returns 401 without token', async () => {
    const res = await request(app).get('/ingredient/get-all')
    expect(res.status).toBe(401)
  })
})

// ===================== F21-03 DEFENSE IN DEPTH =====================
// getAll previously computed its own store scope from the raw, client-
// supplied req.query.store instead of the hardened resolveStoreId(req)
// helper every other function in this file already uses. Over the real
// route chain, validateStoreAccess already 403s a mismatched ?store= for
// non-super-admin, so the leak is not reachable via HTTP today — but the
// controller itself was not independently safe: it trusted req.query.store
// over req.storeId (the value the middleware actually verified and pinned).
// This drives the controller directly, the way store-price-contract.test.js
// already does elsewhere in this suite, to prove the controller's OWN store
// resolution — not just the route's middleware — is now correct. This is
// exactly the defense-in-depth class of bug utils/tenantScope.js's own
// header comment describes: a controller trusting client input directly is
// only ever as safe as the specific middleware chain in front of it.
describe('F21-03 getAll trusts req.storeId over a forged req.query.store', () => {
  const mockRes = () => {
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) }
    return res
  }

  test('a non-super-admin request with req.storeId=store1 but req.query.store=store2 never returns store2 data', async () => {
    const req = {
      query: { store: String(ingStore2.store) },
      user: { roleType: 'admin', store: ingStore1.store },
      storeId: ingStore1.store
    }
    const res = mockRes()

    await ingredientController.getAll(req, res)

    const payload = res.json.mock.calls[0][0]
    const names = (payload.data || []).map((i) => i.name)
    expect(names).toContain('TEST_ISOLATION_STORE1')
    expect(names).not.toContain('TEST_ISOLATION_STORE2')
  })

  test('a super_admin request with an explicit req.query.store still scopes to that store', async () => {
    const req = {
      query: { store: String(ingStore2.store) },
      user: { roleType: 'super_admin' },
      storeId: ingStore2.store
    }
    const res = mockRes()

    await ingredientController.getAll(req, res)

    const payload = res.json.mock.calls[0][0]
    const names = (payload.data || []).map((i) => i.name)
    expect(names).toContain('TEST_ISOLATION_STORE2')
    expect(names).not.toContain('TEST_ISOLATION_STORE1')
  })
})
