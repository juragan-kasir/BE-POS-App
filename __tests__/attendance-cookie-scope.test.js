process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Same bug class as cash-register/history: a stale `activeStore` cookie must
// not scope the global super_admin view of today's attendance.

const SUFFIX = Date.now()

let storeA = null
let storeB = null
let opener = null
let superToken = null
const createdIds = []

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: `ATC_STORE_A_${SUFFIX}` }))
  storeB = await db.location.create(await withTestTenant({ name: `ATC_STORE_B_${SUFFIX}` }))
  opener = await db.user.create({
    userName: `atc_opener_${SUFFIX}`,
    // AUTH-1 P2: authority comes from this row, not the JWT — the caller these
    // tests mean (per the token claims) is a global super_admin.
    roleType: 'super_admin',
    store: null,
    password: 'x'
  })
  superToken = await signSessionToken(
    { id: opener.id, userName: 'atc_super', roleType: 'super_admin', store: null },
    JWT_SECRET
  )
  const now = new Date()
  for (const [store, key] of [
    [storeA, 'A'],
    [storeB, 'B']
  ]) {
    const row = await db.attendance.create({
      userId: opener.id,
      store: store.id,
      absenAt: now,
      note: `ATC-${key}-${SUFFIX}`
    })
    createdIds.push(row.id)
  }
})

afterAll(async () => {
  await db.attendance
    .destroy({ where: { id: createdIds.filter(Boolean) }, force: true })
    .catch(() => {})
  await db.user.destroy({ where: { id: opener?.id }, force: true }).catch(() => {})
  await db.location
    .destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true })
    .catch(() => {})
})

describe('attendance today cookie scope', () => {
  test('stale activeStore cookie must NOT scope Semua Toko to one store', async () => {
    const res = await request(app)
      .get('/attendance/today')
      .set('Authorization', `Bearer ${superToken}`)
      .set('Cookie', `activeStore=${storeA.id}`)
    expect(res.status).toBe(200)
    const stores = new Set((res.body.data || []).map((row) => Number(row.store)))
    expect(stores.has(Number(storeA.id))).toBe(true)
    expect(stores.has(Number(storeB.id))).toBe(true)
  })
})
