process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// C-1..C-4 regression — multi-store authorization bypass on tenant WRITES.
//
// Root cause (independent audit): validateStoreAccess validates the requested
// store with scalar parseInt-style coercion, so an admin can submit a store
// representation that "passes" while actually targeting a FOREIGN store:
//   - [own, foreign]          parseInt([.]) -> first (own) -> passes
//   - JSON-string "["foreign"]"  parseInt -> NaN -> falsy -> passes
// The write controllers (type_payment, category store-junction, shift,
// delivery drivers) then trust that requested store list and write rows into
// the foreign tenant's namespace.
//
// Canonical rule (per task): for non-super-admin with authoritative store S,
// the requested store set MUST be exactly {S}. Any representation that
// resolves to ANY foreign store, or to more than one distinct authorized
// outcome, must REJECT the WHOLE request before any DB write — never
// [own+A], never partial store-A mutation.
//
// These tests drive the real route/middleware/controller chain and assert
// HTTP status, foreign-row absence, own-row absence on rejection, and no
// partial mutation.

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA = null
let storeB = null
let adminA = null
let adminB = null
let superToken = null

const mkToken = (roleType, store, id) =>
  signSessionToken(
    { id, userName: `c12_${roleType}_${id}`, roleType, store },
    JWT_SECRET
  )

const TARGETS = []

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'C12_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'C12_STORE_B', status: 'active' }))

  // P1-4: central gate denies unknown caller identities; these rows give
  // the caller ids real identities (unassigned ids use store null to
  // preserve unassigned controller semantics). Assertions unchanged.
  for (const [id, userName, roleType, userType, store] of [
    [81201, 'c12_admin_a', 'admin', 'admin', storeA.id],
    [81202, 'c12_admin_b', 'admin', 'admin', storeB.id],
    [81200, 'c12_super', 'super_admin', 'admin', null],
    [81203, 'c12_unassigned1', 'admin', 'admin', null],
    [81204, 'c12_unassigned2', 'admin', 'admin', null],
    [81205, 'c12_unassigned3', 'admin', 'admin', null],
    [81206, 'c12_unassigned4', 'admin', 'admin', null]
  ]) {
    await db.user.create({
      id,
      userName,
      email: `p14-${id}-chigh@test.com`,
      roleType,
      userType,
      store,
      status: 'active',
      fullName: userName
    })
  }
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminA = await mkToken('admin', storeA.id, 81201)
  adminB = await mkToken('admin', storeB.id, 81202)
  superToken = await mkToken('super_admin', null, 81200)
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [81201, 81202, 81200, 81203, 81204, 81205, 81206] }, force: true })
  if (storeB) await db.location.destroy({ where: { id: storeB.id }, force: true })
  if (storeA) await db.location.destroy({ where: { id: storeA.id }, force: true })
})

// ---------------------------------------------------------------- type_payment
const typePaymentNames = []
const postTypePayment = (token, body) =>
  request(app)
    .post('/type-payment/add-new-type-payment')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

// Helper that asserts no type_payment row was created under storeB AND storeA
// (rejection must block partial own-store mutation too).
async function assertNoTypePaymentLeak(name) {
  const inB = await db.type_payment.count({ where: { store: storeB.id, name } })
  const inA = await db.type_payment.count({ where: { store: storeA.id, name } })
  return { inA, inB }
}

describe('C-1 type_payment create — multi-store write authorization', () => {
  test('mixed [own, foreign] store is rejected; NOTHING created in A or B', async () => {
    const name = `C1_MIX_${Date.now()}`
    typePaymentNames.push(name)
    const res = await postTypePayment(adminA, { name, store: [storeA.id, storeB.id] })
    const { inA, inB } = await assertNoTypePaymentLeak(name)
    expect(res.status).toBe(403)
    expect(inB).toBe(0)
    expect(inA).toBe(0)
  })

  test('reversed [foreign, own] store is rejected; nothing created', async () => {
    const name = `C1_REV_${Date.now()}`
    typePaymentNames.push(name)
    const res = await postTypePayment(adminA, { name, store: [storeB.id, storeA.id] })
    const { inA, inB } = await assertNoTypePaymentLeak(name)
    expect(res.status).toBe(403)
    expect(inA).toBe(0)
    expect(inB).toBe(0)
  })

  test('JSON-string-array of own+foreign is rejected', async () => {
    const name = `C1_JSON_${Date.now()}`
    typePaymentNames.push(name)
    const res = await postTypePayment(adminA, {
      name,
      store: JSON.stringify([storeA.id, storeB.id])
    })
    const { inA, inB } = await assertNoTypePaymentLeak(name)
    expect(res.status).toBe(403)
    expect(inA).toBe(0)
    expect(inB).toBe(0)
  })

  test('JSON-string-array of a SINGLE own store is allowed', async () => {
    const name = `C1_JSONOK_${Date.now()}`
    typePaymentNames.push(name)
    const res = await postTypePayment(adminA, {
      name,
      store: JSON.stringify([storeA.id])
    })
    expect(res.status).toBe(200)
    const inA = await db.type_payment.count({ where: { store: storeA.id, name } })
    const inB = await db.type_payment.count({ where: { store: storeB.id, name } })
    expect(inA).toBe(1)
    expect(inB).toBe(0)
  })

  test('duplicate own stores [A,A] resolves to own-only and is allowed', async () => {
    const name = `C1_DUP_${Date.now()}`
    typePaymentNames.push(name)
    const res = await postTypePayment(adminA, { name, store: [storeA.id, storeA.id] })
    expect(res.status).toBe(200)
    const inA = await db.type_payment.count({ where: { store: storeA.id, name } })
    expect(inA).toBe(1)
  })

  test('plain scalar foreign store is rejected (already enforced)', async () => {
    const name = `C1_FOREIGN_${Date.now()}`
    typePaymentNames.push(name)
    const res = await postTypePayment(adminA, { name, store: storeB.id })
    const { inA, inB } = await assertNoTypePaymentLeak(name)
    expect(res.status).toBe(403)
    expect(inA).toBe(0)
    expect(inB).toBe(0)
  })

  test('empty string / undefined store falls back to own store only for admin', async () => {
    const name = `C1_NOSTORE_${Date.now()}`
    typePaymentNames.push(name)
    const res = await postTypePayment(adminA, { name })
    expect(res.status).toBe(200)
    const inA = await db.type_payment.count({ where: { store: storeA.id, name } })
    expect(inA).toBe(1)
  })

  test('unassigned admin (no store claim) is 403 even with forged store array', async () => {
    const unassigned = await mkToken('admin', null, 81203)
    const res = await postTypePayment(unassigned, {
      name: `C1_UNASSIGNED_${Date.now()}`,
      store: [storeA.id, storeB.id]
    })
    expect(res.status).toBe(403)
  })

  test('super_admin multi-store create is preserved (explicit selector)', async () => {
    const name = `C1_SUPER_${Date.now()}`
    const res = await postTypePayment(superToken, {
      name,
      store: [storeA.id, storeB.id]
    })
    expect(res.status).toBe(200)
    const inA = await db.type_payment.count({ where: { store: storeA.id, name } })
    const inB = await db.type_payment.count({ where: { store: storeB.id, name } })
    expect(inA).toBe(1)
    expect(inB).toBe(1)
  })
})

// ---------------------------------------------------------------- shift
const postShift = (token, body) =>
  request(app)
    .post('/shift/add-new-shift')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

async function assertNoShiftLeak(name) {
  const inB = await db.shift.count({ where: { store: storeB.id, name } })
  const inA = await db.shift.count({ where: { store: storeA.id, name } })
  return { inA, inB }
}

describe('C-3 shift create — multi-store write authorization', () => {
  const shiftBody = (name, store) => ({
    nama_shift: name,
    jam_mulai: '08:00',
    jam_selesai: '16:00',
    status: 'active',
    ...(store !== undefined ? { store } : {})
  })

  test('shift mixed [own, foreign] is rejected; nothing created', async () => {
    const name = `C3_MIX_${Date.now()}`
    const res = await postShift(adminA, shiftBody(name, [storeA.id, storeB.id]))
    const { inA, inB } = await assertNoShiftLeak(name)
    expect(res.status).toBe(403)
    expect(inA).toBe(0)
    expect(inB).toBe(0)
  })

  test('shift JSON-string-array with foreign is rejected', async () => {
    const name = `C3_JSON_${Date.now()}`
    const res = await postShift(adminA, shiftBody(name, JSON.stringify([storeA.id, storeB.id])))
    const { inA, inB } = await assertNoShiftLeak(name)
    expect(res.status).toBe(403)
    expect(inA).toBe(0)
    expect(inB).toBe(0)
  })

  test('shift single-own JSON string is allowed (own only)', async () => {
    const name = `C3_OK_${Date.now()}`
    const res = await postShift(adminA, shiftBody(name, JSON.stringify([storeA.id])))
    expect(res.status).toBe(200)
    const inA = await db.shift.count({ where: { store: storeA.id, name } })
    const inB = await db.shift.count({ where: { store: storeB.id, name } })
    expect(inA).toBe(1)
    expect(inB).toBe(0)
  })

  test('shift scalar foreign store is rejected', async () => {
    const name = `C3_FOREIGN_${Date.now()}`
    const res = await postShift(adminA, shiftBody(name, storeB.id))
    const { inA, inB } = await assertNoShiftLeak(name)
    expect(res.status).toBe(403)
    expect(inA).toBe(0)
    expect(inB).toBe(0)
  })

  test('shift explicitly emptied store (null) defaults to own store only', async () => {
    const name = `C3_NULL_${Date.now()}`
    const res = await postShift(adminA, shiftBody(name, null))
    expect(res.status).toBe(200)
    const inA = await db.shift.count({ where: { store: storeA.id, name } })
    const inB = await db.shift.count({ where: { store: storeB.id, name } })
    expect(inA).toBe(1)
    expect(inB).toBe(0)
  })

  test('unassigned admin shift create is 403', async () => {
    const unassigned = await mkToken('admin', null, 81204)
    const res = await postShift(unassigned, shiftBody(`C3_UN_${Date.now()}`, [storeA.id]))
    expect(res.status).toBe(403)
  })

  test('super_admin multi-store shift create is preserved', async () => {
    const name = `C3_SUPER_${Date.now()}`
    const res = await postShift(superToken, shiftBody(name, [storeA.id, storeB.id]))
    expect(res.status).toBe(200)
    const inA = await db.shift.count({ where: { store: storeA.id, name } })
    const inB = await db.shift.count({ where: { store: storeB.id, name } })
    expect(inA).toBe(1)
    expect(inB).toBe(1)
  })
})

// ---------------------------------------------------------------- category
const postCategory = (token, body) =>
  request(app)
    .post('/category/add-new-category')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

async function assertNoCategoryLeak(name) {
  const category = await db.category.findOne({ where: { name } })
  if (!category) return { cat: null, inA: 0, inB: 0 }
  const rows = await db.category_store.findAll({
    where: { category: category.id },
    attributes: ['store'],
    raw: true
  })
  return {
    cat: category,
    inA: rows.filter((r) => r.store === storeA.id).length,
    inB: rows.filter((r) => r.store === storeB.id).length
  }
}

describe('C-2 category store-assignment — multi-store write authorization', () => {
  test('category mixed [own, foreign] store is rejected; no junction into B', async () => {
    const name = `C2_MIX_${Date.now()}`
    const res = await postCategory(adminA, { name, store: [storeA.id, storeB.id] })
    const { inA, inB } = await assertNoCategoryLeak(name)
    expect(res.status).toBe(403)
    expect(inB).toBe(0)
  })

  test('category JSON-string-array with foreign is rejected', async () => {
    const name = `C2_JSON_${Date.now()}`
    const res = await postCategory(adminA, {
      name,
      store: JSON.stringify([storeA.id, storeB.id])
    })
    const { inA, inB } = await assertNoCategoryLeak(name)
    expect(res.status).toBe(403)
    expect(inA).toBe(0)
    expect(inB).toBe(0)
  })

  test('category single-own JSON string is allowed, junction only for own store', async () => {
    const name = `C2_OK_${Date.now()}`
    const res = await postCategory(adminA, { name, store: JSON.stringify([storeA.id]) })
    expect(res.status).toBe(200)
    const { inA, inB } = await assertNoCategoryLeak(name)
    expect(inA).toBe(1)
    expect(inB).toBe(0)
  })

  test('category omitted store defaults to own store junction', async () => {
    const name = `C2_NOSTORE_${Date.now()}`
    const res = await postCategory(adminA, { name })
    expect(res.status).toBe(200)
    const { inA, inB } = await assertNoCategoryLeak(name)
    expect(inA).toBe(1)
    expect(inB).toBe(0)
  })

  test('unassigned admin category create is 403', async () => {
    const unassigned = await mkToken('admin', null, 81206)
    const res = await postCategory(unassigned, { name: `C2_UN_${Date.now()}`, store: [storeA.id] })
    expect(res.status).toBe(403)
  })

  test('super_admin multi-store category assignment is preserved', async () => {
    const name = `C2_SUPER_${Date.now()}`
    const res = await postCategory(superToken, {
      name,
      store: [storeA.id, storeB.id]
    })
    expect(res.status).toBe(200)
    const { inA, inB } = await assertNoCategoryLeak(name)
    expect(inA).toBe(1)
    expect(inB).toBe(1)
  })
})

// ---------------------------------------------------------------- delivery driver
const postDriver = (token, body) =>
  request(app)
    .post('/delivery/drivers')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

describe('C-4 delivery driver create — multi-store write authorization', () => {
  test('driver mixed [own, foreign] store is rejected; no driver created', async () => {
    const name = `C4_MIX_${Date.now()}`
    const before = await db.driver.count({ where: { name } })
    const res = await postDriver(adminA, { name, store: [storeA.id, storeB.id] })
    const after = await db.driver.count({ where: { name } })
    expect(res.status).toBe(403)
    expect(after).toBe(before)
  })

  test('driver JSON-string-array with foreign is rejected', async () => {
    const name = `C4_JSON_${Date.now()}`
    const res = await postDriver(adminA, {
      name,
      store: JSON.stringify([storeA.id, storeB.id])
    })
    expect(res.status).toBe(403)
    const created = await db.driver.count({ where: { name } })
    expect(created).toBe(0)
  })

  test('driver single-own JSON string is allowed', async () => {
    const name = `C4_OK_${Date.now()}`
    const res = await postDriver(adminA, { name, store: JSON.stringify([storeA.id]) })
    expect(res.status).toBe(201)
    const row = await db.driver.findOne({ where: { name } })
    expect(row).toBeTruthy()
    expect(Array.isArray(row.store)).toBe(true)
  })

  test('driver omitted store for admin defaults to own store', async () => {
    const name = `C4_NOSTORE_${Date.now()}`
    const res = await postDriver(adminA, { name })
    expect(res.status).toBe(201)
    const row = await db.driver.findOne({ where: { name } })
    expect(row).toBeTruthy()
    expect(Array.isArray(row.store)).toBe(true)
    expect(row.store[0]).toBe(storeA.id)
  })

  test('unassigned admin driver create is 403', async () => {
    const unassigned = await mkToken('admin', null, 81205)
    const res = await postDriver(unassigned, { name: `C4_UN_${Date.now()}`, store: [storeA.id] })
    expect(res.status).toBe(403)
  })

  test('super_admin multi-store driver create is preserved', async () => {
    const name = `C4_SUPER_${Date.now()}`
    const res = await postDriver(superToken, { name, store: [storeA.id, storeB.id] })
    expect(res.status).toBe(201)
    const row = await db.driver.findOne({ where: { name } })
    expect(row).toBeTruthy()
    const arr = Array.isArray(row.store) ? row.store : [row.store]
    expect(arr).toContain(storeA.id)
    expect(arr).toContain(storeB.id)
  })
})
