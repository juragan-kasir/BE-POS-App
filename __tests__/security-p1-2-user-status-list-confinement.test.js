process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const { Op } = require('sequelize')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const PREFIX = `p12_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const sign = (claims) => signSessionToken(claims, JWT_SECRET)
const bearer = (token) => ({ Authorization: `Bearer ${token}` })

let storeA = null
let storeB = null
const actors = {}
const createdUserIds = []

const makeUser = async (key, attrs) => {
  const name = unique(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: 'Rahasia123!',
    fullName: name,
    userType: 'user',
    status: 'active',
    ...attrs
  })
  createdUserIds.push(row.id)
  return row
}

const snapshotUser = async (id) => {
  const row = await db.user.findByPk(id, { paranoid: false })
  const { roleType, store, status, updatedAt } = row.get({ plain: true })
  return { roleType, store, status, updatedAt }
}

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: unique('STORE_A'), status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: unique('STORE_B'), status: 'active' }))
  actors.adminA = await makeUser('adminA', { roleType: 'admin', userType: 'admin', store: storeA.id })
  actors.superGlobal = await makeUser('superGlobal', { roleType: 'super_admin', userType: 'admin', store: null })
  actors.superBoundA = await makeUser('superBoundA', { roleType: 'super_admin', userType: 'admin', store: storeA.id })
  actors.globalTarget = await makeUser('globalTarget', { roleType: 'super_admin', userType: 'admin', store: null })
})

afterAll(async () => {
  const rows = await db.user.findAll({ where: { id: createdUserIds }, attributes: ['id'], paranoid: false })
  const ids = rows.map((r) => r.id)
  if (ids.length) await db.user.destroy({ where: { id: ids }, force: true }).catch(() => {})
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true }).catch(() => {})
})

const tokens = async () => ({
  adminA: await sign({ id: actors.adminA.id, roleType: 'admin', store: storeA.id }),
  superGlobal: await sign({ id: actors.superGlobal.id, roleType: 'super_admin', store: null }),
  superBoundA: await sign({ id: actors.superBoundA.id, roleType: 'super_admin', store: storeA.id })
})

// ---- change-user-status ----
describe('P1-2 change-user-status confinement', () => {
  test('bound own-store user → 200 + changed', async () => {
    const target = await makeUser('stOwn', { roleType: 'user', store: storeA.id })
    const res = await request(app).put('/auth/change-user-status').set(bearer((await tokens()).superBoundA)).send({ id: target.id, status: 'inactive' })
    expect(res.status).toBe(200)
    expect((await db.user.findByPk(target.id)).status).toBe('inactive')
  })

  test('bound foreign user → 403 + unchanged', async () => {
    const target = await makeUser('stFor', { roleType: 'user', store: storeB.id })
    const before = await snapshotUser(target.id)
    const res = await request(app).put('/auth/change-user-status').set(bearer((await tokens()).superBoundA)).send({ id: target.id, status: 'inactive' })
    expect(res.status).toBe(403)
    expect(await snapshotUser(target.id)).toEqual(before)
  })

  test('bound global super_admin target → 403 + unchanged', async () => {
    const before = await snapshotUser(actors.globalTarget.id)
    const res = await request(app).put('/auth/change-user-status').set(bearer((await tokens()).superBoundA)).send({ id: actors.globalTarget.id, status: 'inactive' })
    expect(res.status).toBe(403)
    expect(await snapshotUser(actors.globalTarget.id)).toEqual(before)
  })

  test('bound missing → 404', async () => {
    const res = await request(app).put('/auth/change-user-status').set(bearer((await tokens()).superBoundA)).send({ id: 2147480000, status: 'inactive' })
    expect(res.status).toBe(404)
  })

  test('global any target → 200 (own, foreign, super_admin)', async () => {
    const t = (await tokens()).superGlobal
    const own = await makeUser('stG1', { roleType: 'user', store: storeA.id })
    const foreign = await makeUser('stG2', { roleType: 'user', store: storeB.id })
    expect((await request(app).put('/auth/change-user-status').set(bearer(t)).send({ id: own.id, status: 'inactive' })).status).toBe(200)
    expect((await request(app).put('/auth/change-user-status').set(bearer(t)).send({ id: foreign.id, status: 'inactive' })).status).toBe(200)
    expect((await request(app).put('/auth/change-user-status').set(bearer(t)).send({ id: actors.globalTarget.id, status: 'active' })).status).toBe(200)
    expect((await request(app).put('/auth/change-user-status').set(bearer(t)).send({ id: 2147480000, status: 'inactive' })).status).toBe(404)
  })
})

// ---- get-all-user ----
describe('P1-2 get-all-user confinement', () => {
  test('bound sees own normal users; no foreign, no global/foreign super_admin; shape preserved', async () => {
    const ownUser = await makeUser('liOwn', { roleType: 'user', store: storeA.id })
    const foreignUser = await makeUser('liFor', { roleType: 'user', store: storeB.id })
    const res = await request(app).get('/auth/get-all-user').set(bearer((await tokens()).superBoundA))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    const ids = res.body.data.map((u) => u.id)
    expect(ids).toContain(ownUser.id)
    expect(ids).not.toContain(foreignUser.id)
    expect(ids).not.toContain(actors.globalTarget.id)
    expect(ids).not.toContain(actors.superBoundA.id)
    for (const u of res.body.data) {
      expect(u.store).toBe(storeA.id)
      expect(u.roleType).not.toBe('super_admin')
      expect(u.password).toBeUndefined()
    }
  })

  test('global audience unchanged (sees own, foreign, super_admin)', async () => {
    const res = await request(app).get('/auth/get-all-user').set(bearer((await tokens()).superGlobal))
    expect(res.status).toBe(200)
    const ids = res.body.data.map((u) => u.id)
    expect(ids).toContain(actors.globalTarget.id)
  })
})

// ---- get-user / location ----
describe('P1-2 get-user location confinement', () => {
  test('bound omitted → own; own → own; foreign → 403 with no foreign data', async () => {
    const t = (await tokens()).superBoundA
    let res = await request(app).get('/auth/get-user').set(bearer(t))
    expect(res.status).toBe(200)
    res = await request(app).get(`/auth/get-user?location=${storeA.id}`).set(bearer(t))
    expect(res.status).toBe(200)
    res = await request(app).get(`/auth/get-user?location=${storeB.id}`).set(bearer(t))
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain('liFor')
  })

  test('global + admin preserved', async () => {
    const res = await request(app).get(`/auth/get-user?location=${storeB.id}`).set(bearer((await tokens()).superGlobal))
    expect(res.status).toBe(200)
    const adminRes = await request(app).get('/auth/get-user').set(bearer((await tokens()).adminA))
    expect(adminRes.status).toBe(200)
  })
})
