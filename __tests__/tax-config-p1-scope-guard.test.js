process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// P1: outlet admins must not mutate global (store-null) tax rows; reading
// the list must not seed default rows. Fixture names are T1G_-prefixed and
// removed in afterAll. The empty-table precondition for the seed-on-read
// test is established by an explicit full wipe in beforeAll — other suites
// create their own fixtures per file and clean up after themselves.
let storeA = null
let storeB = null
let adminAToken = null
let superToken = null
let boundSuperToken = null
let globalRow = null
let globalRow2 = null
let outletRowA = null
let outletRowB = null

const taxUrl = (storeId) => `/tax-config?store=${storeId}`

beforeAll(async () => {
  await db.taxConfig.destroy({ where: {}, force: true })
  storeA = await db.location.create(await withTestTenant({ name: 'T1G_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'T1G_STORE_B', status: 'active' }))
  await db.user.create({
    id: 9921,
    userName: 't1g_admin_a',
    email: 'p1-9921-t1g@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active',
    fullName: 't1g_admin_a'
  })
  await db.user.create({
    id: 9923,
    userName: 't1g_super',
    email: 'p1-9923-t1g@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 't1g_super'
  })
  await db.user.create({
    id: 9924,
    userName: 't1g_bound_super',
    email: 'p1-9924-t1g@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active',
    fullName: 't1g_bound_super'
  })
  adminAToken = await signSessionToken(
    { id: 9921, userName: 't1g_admin_a', roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 9923, userName: 't1g_super', roleType: 'super_admin', store: null },
    JWT_SECRET
  )
  boundSuperToken = await signSessionToken(
    { id: 9924, userName: 't1g_bound_super', roleType: 'super_admin', store: storeA.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: {}, force: true })
  await db.user.destroy({ where: { id: [9921, 9923, 9924] }, force: true })
  await db.location.destroy({
    where: { id: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
})

describe('P1-B seed-on-read: GET /tax-config creates nothing', () => {
  test('list against an empty table returns empty and creates no rows', async () => {
    const res = await request(app)
      .get(taxUrl(storeA.id))
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    expect(await db.taxConfig.count()).toBe(0)
  })
})

describe('P1-A global-row guard', () => {
  beforeAll(async () => {
    globalRow = await db.taxConfig.create({
      name: 'T1G_GLOBAL_PPN',
      rate: 11,
      type: 'ppn',
      description: 'global fixture',
      status: 'active',
      store: null
    })
    globalRow2 = await db.taxConfig.create({
      name: 'T1G_GLOBAL_PPN_2',
      rate: 11,
      type: 'ppn',
      description: 'global fixture 2',
      status: 'active',
      store: null
    })
    outletRowA = await db.taxConfig.create({
      name: 'T1G_OUTLET_A',
      rate: 10,
      type: 'ppn',
      description: 'outlet A fixture',
      status: 'active',
      store: storeA.id
    })
    outletRowB = await db.taxConfig.create({
      name: 'T1G_OUTLET_B',
      rate: 10,
      type: 'ppn',
      description: 'outlet B fixture',
      status: 'active',
      store: storeB.id
    })
  })

  test('outlet admin cannot update a global row (403, row unchanged)', async () => {
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${globalRow.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ name: 'T1G_HACKED', rate: 99 })
    expect(res.status).toBe(403)
    const fresh = await db.taxConfig.findByPk(globalRow.id)
    expect(fresh.name).toBe('T1G_GLOBAL_PPN')
    expect(fresh.rate).toBe(11)
    expect(fresh.store).toBeNull()
  })

  test('outlet admin cannot delete a global row (403, row survives)', async () => {
    const res = await request(app)
      .delete(`/tax-config/delete-tax-config/${globalRow.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${adminAToken}`)
    expect(res.status).toBe(403)
    expect(await db.taxConfig.findByPk(globalRow.id)).not.toBeNull()
  })

  test('store-bound super_admin cannot update a global row (403, unchanged)', async () => {
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${globalRow.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${boundSuperToken}`)
      .send({ name: 'T1G_HACKED', rate: 99 })
    expect(res.status).toBe(403)
    const fresh = await db.taxConfig.findByPk(globalRow.id)
    expect(fresh.name).toBe('T1G_GLOBAL_PPN')
    expect(fresh.rate).toBe(11)
    expect(fresh.store).toBeNull()
  })

  test('platform admin can update a global row', async () => {
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${globalRow.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ description: 'edited by platform admin' })
    expect(res.status).toBe(200)
    const fresh = await db.taxConfig.findByPk(globalRow.id)
    expect(fresh.description).toBe('edited by platform admin')
    expect(fresh.store).toBeNull()
  })

  test('platform admin moving a global row to an outlet is refused (409, unchanged)', async () => {
    const before = (await db.taxConfig.findByPk(globalRow.id)).toJSON()
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${globalRow.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ description: 'scope probe', store: storeB.id })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TAX_SCOPE_IMMUTABLE')
    const fresh = await db.taxConfig.findByPk(globalRow.id)
    expect(fresh.toJSON()).toEqual(before)
    expect(fresh.store).toBeNull()
  })

  test('platform admin moving an outlet row to another outlet is refused (409, unchanged)', async () => {
    const before = (await db.taxConfig.findByPk(outletRowA.id)).toJSON()
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${outletRowA.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ description: 'scope probe', store: storeB.id })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TAX_SCOPE_IMMUTABLE')
    const fresh = await db.taxConfig.findByPk(outletRowA.id)
    expect(fresh.toJSON()).toEqual(before)
    expect(fresh.store).toBe(storeA.id)
  })

  test('platform admin moving an outlet row to global (store: null) is refused (409, unchanged)', async () => {
    const before = (await db.taxConfig.findByPk(outletRowA.id)).toJSON()
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${outletRowA.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ description: 'scope probe', store: null })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TAX_SCOPE_IMMUTABLE')
    const fresh = await db.taxConfig.findByPk(outletRowA.id)
    expect(fresh.toJSON()).toEqual(before)
    expect(fresh.store).toBe(storeA.id)
  })

  test('outlet admin requesting global scope for an own row is refused (409, unchanged)', async () => {
    const before = (await db.taxConfig.findByPk(outletRowA.id)).toJSON()
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${outletRowA.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ rate: 99, store: null })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TAX_SCOPE_IMMUTABLE')
    const fresh = await db.taxConfig.findByPk(outletRowA.id)
    expect(fresh.toJSON()).toEqual(before)
  })

  test('platform admin supplying the same global scope updates normally', async () => {
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${globalRow.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ description: 'same global scope', store: null })
    expect(res.status).toBe(200)
    const fresh = await db.taxConfig.findByPk(globalRow.id)
    expect(fresh.description).toBe('same global scope')
    expect(fresh.store).toBeNull()
  })

  test('outlet admin supplying the same outlet scope updates normally', async () => {
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${outletRowA.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ description: 'same outlet scope', store: storeA.id })
    expect(res.status).toBe(200)
    const fresh = await db.taxConfig.findByPk(outletRowA.id)
    expect(fresh.description).toBe('same outlet scope')
    expect(fresh.store).toBe(storeA.id)
  })

  test('platform admin can delete a global row', async () => {
    const res = await request(app)
      .delete(`/tax-config/delete-tax-config/${globalRow2.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${superToken}`)
    expect(res.status).toBe(200)
    expect(await db.taxConfig.findByPk(globalRow2.id)).toBeNull()
  })

  test('outlet admin can still manage an authorized outlet-scoped row', async () => {
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${outletRowA.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ rate: 12 })
    expect(res.status).toBe(200)
    const fresh = await db.taxConfig.findByPk(outletRowA.id)
    expect(fresh.rate).toBe(12)
    expect(fresh.store).toBe(storeA.id)
  })

  test("outlet admin cannot manage another outlet's row (404, unchanged)", async () => {
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${outletRowB.id}?store=${storeA.id}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ rate: 99 })
    expect(res.status).toBe(404)
    const fresh = await db.taxConfig.findByPk(outletRowB.id)
    expect(fresh.rate).toBe(10)
    expect(fresh.store).toBe(storeB.id)
  })
})
