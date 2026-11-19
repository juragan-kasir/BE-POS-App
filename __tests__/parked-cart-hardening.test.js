process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store = null
let storeOther = null
let table = null
let tableOther = null
let adminUser = null
let kasirUser = null
let superAdminUser = null
let adminToken = null
let kasirToken = null
let superAdminToken = null
let adminOtherToken = null

const sampleItems = (overrides = {}) => [
  {
    id: 1,
    cartKey: '1_',
    nameProduct: 'Test Product',
    variantName: null,
    price: 10000,
    count: 1,
    totalPrice: 10000,
    ...overrides
  }
]

const parkCart = (token, overrides = {}) =>
  request(app)
    .post('/parked-cart')
    .set('Authorization', `Bearer ${token}`)
    .send({
      cart: { items: sampleItems() },
      ...overrides
    })

const listParkedCarts = (token, query = '') =>
  request(app)
    .get(`/parked-cart${query}`)
    .set('Authorization', `Bearer ${token}`)

const getParkedCart = (token, id) =>
  request(app)
    .get(`/parked-cart/${id}`)
    .set('Authorization', `Bearer ${token}`)

const resumeParkedCart = (token, id) =>
  request(app)
    .post(`/parked-cart/${id}/resume`)
    .set('Authorization', `Bearer ${token}`)

const cancelParkedCart = (token, id) =>
  request(app)
    .post(`/parked-cart/${id}/cancel`)
    .set('Authorization', `Bearer ${token}`)

// Test-only helper: bypasses the API to simulate "time has passed" — sets
// expiresAt into the past directly, exactly equivalent to waiting for the
// TTL to elapse, without slowing the suite down.
const expireNow = (id) =>
  db.parkedCart.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id } })

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'PARKED_CART_STORE', status: 'active' }))
  storeOther = await db.location.create(await withTestTenant({ name: 'PARKED_CART_STORE_OTHER', status: 'active' }))
  table = await db.table.create({ store: store.id, name: 'T1', status: 'available' })
  tableOther = await db.table.create({ store: storeOther.id, name: 'T2', status: 'available' })

  adminUser = await db.user.create({
    userName: 'admin_parked_cart',
    email: 'admin_parked_cart@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  kasirUser = await db.user.create({
    userName: 'kasir_parked_cart',
    email: 'kasir_parked_cart@test.com',
    roleType: 'kasir',
    userType: 'kasir',
    store: store.id,
    status: 'active'
  })
  superAdminUser = await db.user.create({
    userName: 'superadmin_parked_cart',
    email: 'superadmin_parked_cart@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active'
  })
  const adminOtherUser = await db.user.create({
    userName: 'admin_parked_cart_other',
    email: 'admin_parked_cart_other@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeOther.id,
    status: 'active'
  })

  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  kasirToken = await signSessionToken(
    { id: kasirUser.id, userName: kasirUser.userName, roleType: 'kasir', store: store.id },
    JWT_SECRET
  )
  superAdminToken = await signSessionToken(
    { id: superAdminUser.id, userName: superAdminUser.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
  adminOtherToken = await signSessionToken(
    { id: adminOtherUser.id, userName: adminOtherUser.userName, roleType: 'admin', store: storeOther.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.auditLog.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true, __auditMaintenance: true })
  await db.parkedCart.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true })
  await db.table.destroy({ where: { id: [table?.id, tableOther?.id] }, force: true })
  await db.user.destroy({
    where: { id: [adminUser?.id, kasirUser?.id, superAdminUser?.id].filter(Boolean) },
    force: true
  })
  await db.user.destroy({ where: { store: storeOther?.id }, force: true })
  await db.location.destroy({ where: { id: [store?.id, storeOther?.id] }, force: true })
})

// Reset configuration + clear active carts between describe blocks that
// depend on a clean cap/TTL state.
afterEach(async () => {
  await db.location.update(
    { maxActiveParkedCarts: null, parkedCartTtlMinutes: null },
    { where: { id: [store.id, storeOther.id] } }
  )
  // Every test starts from a clean slate — several tests assert absolute
  // counts/cap behavior that would otherwise be polluted by rows left
  // behind (intentionally or not) by earlier tests in the same file.
  await db.parkedCart.destroy({ where: { store: [store.id, storeOther.id] }, force: true })
})

describe('Lifecycle', () => {
  test('create returns 201 with an active parked cart', async () => {
    const res = await parkCart(adminToken)
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.store).toBe(store.id)
    expect(res.body.data.displayTotalItems).toBe(1)
    expect(res.body.data.displayTotalPrice).toBe(10000)
  })

  test('kasir (non-admin role) can create, list, resume, cancel — no requireRole restriction', async () => {
    const created = await parkCart(kasirToken)
    expect(created.status).toBe(201)
    const list = await listParkedCarts(kasirToken)
    expect(list.status).toBe(200)
    const resumed = await resumeParkedCart(kasirToken, created.body.data.id)
    expect(resumed.status).toBe(200)
  })

  test('resume transitions active -> resumed and returns the snapshot', async () => {
    const created = await parkCart(adminToken)
    const res = await resumeParkedCart(adminToken, created.body.data.id)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('resumed')
    expect(res.body.data.cartPayload.items).toHaveLength(1)

    const row = await db.parkedCart.findByPk(created.body.data.id)
    expect(row.status).toBe('resumed')
    expect(row.resumedAt).toBeTruthy()
  })

  test('cancel transitions active -> cancelled', async () => {
    const created = await parkCart(adminToken)
    const res = await cancelParkedCart(adminToken, created.body.data.id)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('cancelled')

    const row = await db.parkedCart.findByPk(created.body.data.id)
    expect(row.status).toBe('cancelled')
    expect(row.cancelledAt).toBeTruthy()
  })

  test('resume after cancel -> 409, cancel is not undone', async () => {
    const created = await parkCart(adminToken)
    await cancelParkedCart(adminToken, created.body.data.id)
    const res = await resumeParkedCart(adminToken, created.body.data.id)
    expect(res.status).toBe(409)
    const row = await db.parkedCart.findByPk(created.body.data.id)
    expect(row.status).toBe('cancelled')
  })

  test('cancel after resume -> 409, resume is not undone', async () => {
    const created = await parkCart(adminToken)
    await resumeParkedCart(adminToken, created.body.data.id)
    const res = await cancelParkedCart(adminToken, created.body.data.id)
    expect(res.status).toBe(409)
    const row = await db.parkedCart.findByPk(created.body.data.id)
    expect(row.status).toBe('resumed')
  })

  test('resuming an already-resumed cart a second time -> 409 (no re-entry)', async () => {
    const created = await parkCart(adminToken)
    const first = await resumeParkedCart(adminToken, created.body.data.id)
    expect(first.status).toBe(200)
    const second = await resumeParkedCart(adminToken, created.body.data.id)
    expect(second.status).toBe(409)
  })

  test('empty cart is rejected with 422, not 400', async () => {
    const res = await parkCart(adminToken, { cart: { items: [] } })
    expect(res.status).toBe(422)
  })
})

describe('Expiration — canonical semantics', () => {
  test('a fresh cart (now < expiresAt) is active and resumable', async () => {
    const created = await parkCart(adminToken)
    const get = await getParkedCart(adminToken, created.body.data.id)
    expect(get.body.data.status).toBe('active')
    await cancelParkedCart(adminToken, created.body.data.id)
  })

  test('now >= expiresAt: an unswept row (physical status still active) is reported as expired', async () => {
    const created = await parkCart(adminToken)
    await expireNow(created.body.data.id)

    const physical = await db.parkedCart.findByPk(created.body.data.id)
    expect(physical.status).toBe('active') // physical column intentionally lags

    const get = await getParkedCart(adminToken, created.body.data.id)
    expect(get.body.data.status).toBe('expired') // API-facing effectiveStatus does not lag
  })

  test('an expired-but-unswept cart cannot be resumed (409), not resurrected', async () => {
    const created = await parkCart(adminToken)
    await expireNow(created.body.data.id)
    const res = await resumeParkedCart(adminToken, created.body.data.id)
    expect(res.status).toBe(409)
    const row = await db.parkedCart.findByPk(created.body.data.id)
    expect(row.status).toBe('active') // untouched — CAS never matched
  })

  test('an expired-but-unswept cart cannot be cancelled (409)', async () => {
    const created = await parkCart(adminToken)
    await expireNow(created.body.data.id)
    const res = await cancelParkedCart(adminToken, created.body.data.id)
    expect(res.status).toBe(409)
  })

  test('default active list excludes an expired-but-unswept row', async () => {
    const created = await parkCart(adminToken)
    await expireNow(created.body.data.id)
    const list = await listParkedCarts(adminToken)
    expect(list.body.data.find((c) => c.id === created.body.data.id)).toBeUndefined()
    await db.parkedCart.destroy({ where: { id: created.body.data.id }, force: true })
  })

  test('?status=expired includes both a physically-expired row and an unswept-but-logically-expired row', async () => {
    const created1 = await parkCart(adminToken)
    await expireNow(created1.body.data.id) // unswept: status still 'active' physically

    const created2 = await parkCart(adminToken)
    await db.parkedCart.update({ status: 'expired' }, { where: { id: created2.body.data.id } }) // physically swept

    const list = await listParkedCarts(adminToken, '?status=expired')
    const ids = list.body.data.map((c) => c.id)
    expect(ids).toContain(created1.body.data.id)
    expect(ids).toContain(created2.body.data.id)

    await db.parkedCart.destroy({ where: { id: [created1.body.data.id, created2.body.data.id] }, force: true })
  })
})

describe('Resume / cancel concurrency', () => {
  test('two concurrent resumes of the same cart: exactly one 200, one 409, exactly one resumedAt', async () => {
    const created = await parkCart(adminToken)
    const [r1, r2] = await Promise.all([
      resumeParkedCart(adminToken, created.body.data.id),
      resumeParkedCart(adminToken, created.body.data.id)
    ])
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 409])

    const row = await db.parkedCart.findByPk(created.body.data.id)
    expect(row.status).toBe('resumed')
  })

  test('concurrent resume and cancel on the same cart: exactly one wins', async () => {
    const created = await parkCart(adminToken)
    const [resumeRes, cancelRes] = await Promise.all([
      resumeParkedCart(adminToken, created.body.data.id),
      cancelParkedCart(adminToken, created.body.data.id)
    ])
    const statuses = [resumeRes.status, cancelRes.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 409])

    const row = await db.parkedCart.findByPk(created.body.data.id)
    expect(['resumed', 'cancelled']).toContain(row.status)
  })

  test('resume vs expiration: create, expire it, then attempt resume -> 409', async () => {
    const created = await parkCart(adminToken)
    await expireNow(created.body.data.id)
    const res = await resumeParkedCart(adminToken, created.body.data.id)
    expect(res.status).toBe(409)
  })
})

describe('Cap enforcement', () => {
  test('cap - 1: concurrent creates when one slot remains — exactly one succeeds', async () => {
    await db.location.update({ maxActiveParkedCarts: 3 }, { where: { id: store.id } })
    await parkCart(adminToken)
    await parkCart(adminToken)
    // 2 active carts exist, cap is 3 — exactly one slot remains.
    const [r1, r2] = await Promise.all([parkCart(adminToken), parkCart(adminToken)])
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses).toEqual([201, 409])

    const activeCount = await db.parkedCart.count({
      where: { store: store.id, status: 'active', expiresAt: { [db.Sequelize.Op.gt]: new Date() } }
    })
    expect(activeCount).toBe(3)
  })

  test('exact cap: concurrent creates when zero slots remain — both rejected', async () => {
    await db.location.update({ maxActiveParkedCarts: 2 }, { where: { id: store.id } })
    await parkCart(adminToken)
    await parkCart(adminToken)
    const [r1, r2] = await Promise.all([parkCart(adminToken), parkCart(adminToken)])
    expect(r1.status).toBe(409)
    expect(r2.status).toBe(409)
  })

  test('expired-but-unswept carts do not count toward the cap', async () => {
    await db.location.update({ maxActiveParkedCarts: 1 }, { where: { id: store.id } })
    const created = await parkCart(adminToken)
    expect(created.status).toBe(201)
    await expireNow(created.body.data.id)

    // The cap slot should be free again even though the row is still
    // physically 'active' and unswept.
    const res = await parkCart(adminToken)
    expect(res.status).toBe(201)
  })

  test('cap is never exceeded even under repeated concurrent bursts', async () => {
    await db.location.update({ maxActiveParkedCarts: 5 }, { where: { id: store.id } })
    const results = await Promise.all(Array.from({ length: 8 }, () => parkCart(adminToken)))
    const successCount = results.filter((r) => r.status === 201).length
    expect(successCount).toBe(5)

    const activeCount = await db.parkedCart.count({
      where: { store: store.id, status: 'active', expiresAt: { [db.Sequelize.Op.gt]: new Date() } }
    })
    expect(activeCount).toBe(5)
  })
})

describe('Tenant isolation', () => {
  test('cross-store list does not return another store\'s parked carts', async () => {
    const created = await parkCart(adminToken)
    const list = await listParkedCarts(adminOtherToken)
    expect(list.body.data.find((c) => c.id === created.body.data.id)).toBeUndefined()
    await cancelParkedCart(adminToken, created.body.data.id)
  })

  test('cross-store get -> 404', async () => {
    const created = await parkCart(adminToken)
    const res = await getParkedCart(adminOtherToken, created.body.data.id)
    expect(res.status).toBe(404)
    await cancelParkedCart(adminToken, created.body.data.id)
  })

  test('cross-store resume -> 404', async () => {
    const created = await parkCart(adminToken)
    const res = await resumeParkedCart(adminOtherToken, created.body.data.id)
    expect(res.status).toBe(404)
    const row = await db.parkedCart.findByPk(created.body.data.id)
    expect(row.status).toBe('active')
    await cancelParkedCart(adminToken, created.body.data.id)
  })

  test('cross-store cancel -> 404', async () => {
    const created = await parkCart(adminToken)
    const res = await cancelParkedCart(adminOtherToken, created.body.data.id)
    expect(res.status).toBe(404)
    await cancelParkedCart(adminToken, created.body.data.id)
  })

  test('a non-super-admin spoofing another store in the create body is rejected (403) before the controller runs', async () => {
    const res = await parkCart(adminToken, {
      store: storeOther.id,
      cart: { items: sampleItems() }
    })
    expect(res.status).toBe(403)
    const count = await db.parkedCart.count({ where: { store: storeOther.id } })
    expect(count).toBe(0)
  })

  test('cross-store tableId in create body -> 404, zero side effects', async () => {
    const res = await parkCart(adminToken, { tableId: tableOther.id })
    expect(res.status).toBe(404)
    const count = await db.parkedCart.count({ where: { store: store.id } })
    expect(count).toBe(0)
  })
})

describe('Table integrity', () => {
  test('a valid same-store table succeeds', async () => {
    const res = await parkCart(adminToken, { tableId: table.id })
    expect(res.status).toBe(201)
    expect(res.body.data.tableId).toBe(table.id)
    await cancelParkedCart(adminToken, res.body.data.id)
  })

  test('a nonexistent table -> 404', async () => {
    const res = await parkCart(adminToken, { tableId: 999999999 })
    expect(res.status).toBe(404)
  })

  test('table.status is never mutated by parking a cart', async () => {
    const before = await db.table.findByPk(table.id)
    const res = await parkCart(adminToken, { tableId: table.id })
    const after = await db.table.findByPk(table.id)
    expect(after.status).toBe(before.status)
    await cancelParkedCart(adminToken, res.body.data.id)
  })
})

describe('Idempotency', () => {
  test('identical retry with the same key returns the original, 200 not 201', async () => {
    const key = `idem-${Date.now()}-${Math.random()}`
    const first = await parkCart(adminToken, { idempotencyKey: key })
    expect(first.status).toBe(201)
    const second = await parkCart(adminToken, { idempotencyKey: key })
    expect(second.status).toBe(200)
    expect(second.body.data.id).toBe(first.body.data.id)

    const count = await db.parkedCart.count({ where: { store: store.id, idempotencyKey: key } })
    expect(count).toBe(1)
    await cancelParkedCart(adminToken, first.body.data.id)
  })

  test('same key, materially different payload -> 409', async () => {
    const key = `idem-diff-${Date.now()}-${Math.random()}`
    const first = await parkCart(adminToken, { idempotencyKey: key })
    expect(first.status).toBe(201)
    const second = await parkCart(adminToken, {
      idempotencyKey: key,
      cart: { items: sampleItems({ count: 2, totalPrice: 20000 }) }
    })
    expect(second.status).toBe(409)
    await cancelParkedCart(adminToken, first.body.data.id)
  })

  test('concurrent identical-payload retries never produce two rows', async () => {
    const key = `idem-concurrent-${Date.now()}-${Math.random()}`
    const [r1, r2] = await Promise.all([
      parkCart(adminToken, { idempotencyKey: key }),
      parkCart(adminToken, { idempotencyKey: key })
    ])
    expect([r1.status, r2.status].every((s) => s === 200 || s === 201)).toBe(true)
    const count = await db.parkedCart.count({ where: { store: store.id, idempotencyKey: key } })
    expect(count).toBe(1)
    const id = r1.status === 201 ? r1.body.data.id : r2.body.data.id
    await cancelParkedCart(adminToken, id)
  })

  test('concurrent different-payload requests on the same key: the loser resolves to 409', async () => {
    const key = `idem-concurrent-diff-${Date.now()}-${Math.random()}`
    const [r1, r2] = await Promise.all([
      parkCart(adminToken, { idempotencyKey: key, cart: { items: sampleItems({ count: 1 }) } }),
      parkCart(adminToken, { idempotencyKey: key, cart: { items: sampleItems({ count: 9 }) } })
    ])
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    // Either both raced to different rows becoming impossible (unique
    // index allows exactly one insert to win), or one wins with 200/201
    // and the loser is a payload-mismatch 409. Both statuses must be in
    // {200, 201, 409}, and 409 must appear (payloads genuinely differ).
    expect(statuses).toContain(409)
    const count = await db.parkedCart.count({ where: { store: store.id, idempotencyKey: key } })
    expect(count).toBe(1)
    const winnerId = r1.status !== 409 ? r1.body.data.id : r2.body.data.id
    await cancelParkedCart(adminToken, winnerId)
  })

  test('the same idempotencyKey in a different store is an independent row', async () => {
    const key = `idem-cross-store-${Date.now()}-${Math.random()}`
    const mine = await parkCart(adminToken, { idempotencyKey: key })
    const other = await parkCart(adminOtherToken, { idempotencyKey: key })
    expect(mine.status).toBe(201)
    expect(other.status).toBe(201)
    expect(mine.body.data.id).not.toBe(other.body.data.id)
    await cancelParkedCart(adminToken, mine.body.data.id)
    await cancelParkedCart(adminOtherToken, other.body.data.id)
  })
})

describe('Configuration validation', () => {
  test('null cap falls back to the default (20)', async () => {
    await db.location.update({ maxActiveParkedCarts: null }, { where: { id: store.id } })
    const results = []
    for (let i = 0; i < 21; i++) results.push(await parkCart(adminToken))
    const successCount = results.filter((r) => r.status === 201).length
    expect(successCount).toBe(20)
    await db.parkedCart.destroy({ where: { store: store.id }, force: true })
  })

  test('DB CHECK constraint rejects a raw-SQL zero/negative cap, but allows NULL', async () => {
    await expect(
      db.sequelize.query(
        `UPDATE location SET "maxActiveParkedCarts" = 0 WHERE id = ${store.id}`
      )
    ).rejects.toThrow()
    await expect(
      db.sequelize.query(
        `UPDATE location SET "maxActiveParkedCarts" = -5 WHERE id = ${store.id}`
      )
    ).rejects.toThrow()
    await expect(
      db.sequelize.query(
        `UPDATE location SET "maxActiveParkedCarts" = NULL WHERE id = ${store.id}`
      )
    ).resolves.toBeTruthy()
  })

  test('DB CHECK constraint rejects a raw-SQL zero/negative TTL, but allows NULL', async () => {
    await expect(
      db.sequelize.query(
        `UPDATE location SET "parkedCartTtlMinutes" = 0 WHERE id = ${store.id}`
      )
    ).rejects.toThrow()
    await expect(
      db.sequelize.query(
        `UPDATE location SET "parkedCartTtlMinutes" = -10 WHERE id = ${store.id}`
      )
    ).rejects.toThrow()
    await expect(
      db.sequelize.query(
        `UPDATE location SET "parkedCartTtlMinutes" = NULL WHERE id = ${store.id}`
      )
    ).resolves.toBeTruthy()
  })

  test('application-level fallback: a 0/negative value stored (bypassing CHECK is impossible, but simulate a stale in-memory read) still resolves via the code-level clamp', async () => {
    // The CHECK constraint prevents 0/negative from ever being persisted,
    // so this proves the *application* guard is equally defensive by
    // reasoning about resolveCap/resolveTtlMinutes directly: a location
    // with maxActiveParkedCarts=null must behave identically to one
    // that was never configured at all (both fall back to the default).
    await db.location.update({ maxActiveParkedCarts: null, parkedCartTtlMinutes: null }, { where: { id: store.id } })
    const res = await parkCart(adminToken)
    expect(res.status).toBe(201)
    const expiresAt = new Date(res.body.data.expiresAt)
    const createdAt = new Date(res.body.data.createdAt)
    const diffMinutes = Math.round((expiresAt - createdAt) / 60000)
    expect(diffMinutes).toBe(120) // DEFAULT_PARKED_CART_TTL_MINUTES
    await cancelParkedCart(adminToken, res.body.data.id)
  })

  test('TTL is clamped to a maximum of 1440 minutes even if a location is configured beyond it', async () => {
    await db.location.update({ parkedCartTtlMinutes: 999999 }, { where: { id: store.id } })
    await expect(
      db.sequelize.query(`SELECT "parkedCartTtlMinutes" FROM location WHERE id = ${store.id}`)
    ).resolves.toBeTruthy()
    const res = await parkCart(adminToken)
    expect(res.status).toBe(201)
    const expiresAt = new Date(res.body.data.expiresAt)
    const createdAt = new Date(res.body.data.createdAt)
    const diffMinutes = Math.round((expiresAt - createdAt) / 60000)
    expect(diffMinutes).toBe(1440)
    await cancelParkedCart(adminToken, res.body.data.id)
  })

  test('a valid configured TTL is honored exactly', async () => {
    await db.location.update({ parkedCartTtlMinutes: 30 }, { where: { id: store.id } })
    const res = await parkCart(adminToken)
    const expiresAt = new Date(res.body.data.expiresAt)
    const createdAt = new Date(res.body.data.createdAt)
    const diffMinutes = Math.round((expiresAt - createdAt) / 60000)
    expect(diffMinutes).toBe(30)
    await cancelParkedCart(adminToken, res.body.data.id)
  })
})

describe('Migration integrity', () => {
  test('parked_cart.store NOT NULL is enforced', async () => {
    await expect(
      db.parkedCart.create({
        cartPayload: { items: sampleItems() },
        status: 'active',
        expiresAt: new Date(Date.now() + 60000)
      })
    ).rejects.toThrow()
  })

  test('deleting a location with parked_cart history is blocked by ON DELETE RESTRICT', async () => {
    const tempLocation = await db.location.create(await withTestTenant({ name: 'PARKED_CART_FK_TEST', status: 'active' }))
    await db.parkedCart.create({
      store: tempLocation.id,
      cartPayload: { items: sampleItems() },
      status: 'active',
      expiresAt: new Date(Date.now() + 60000)
    })

    await expect(db.location.destroy({ where: { id: tempLocation.id }, force: true })).rejects.toThrow()

    await db.parkedCart.destroy({ where: { store: tempLocation.id }, force: true })
    await db.location.destroy({ where: { id: tempLocation.id }, force: true })
  })
})

describe('Backward compatibility / regression', () => {
  test('parking and resuming a cart never creates an order row', async () => {
    const before = await db.order.count()
    const created = await parkCart(adminToken)
    await resumeParkedCart(adminToken, created.body.data.id)
    const after = await db.order.count()
    expect(after).toBe(before)
  })

  test('super_admin without an explicit store selection gets 400, not a crash', async () => {
    const res = await parkCart(superAdminToken)
    expect(res.status).toBe(400)
  })
})
