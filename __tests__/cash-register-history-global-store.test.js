process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Reported bug: /cash-register/history as global super_admin ("Semua Toko",
// no store param) returns ONLY the store id carried by a stale
// `activeStore` cookie instead of all stores' registers.

const SUFFIX = Date.now()

let storeA = null
let storeB = null
let opener = null
let superToken = null
let regA = null
let regB = null

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: `CRH_STORE_A_${SUFFIX}` }))
  storeB = await db.location.create(await withTestTenant({ name: `CRH_STORE_B_${SUFFIX}` }))
  opener = await db.user.create({
    userName: `crh_opener_${SUFFIX}`,
    // AUTH-1 P2: authority comes from this row, not the JWT — the caller these
    // tests mean (per the token claims) is a global super_admin.
    roleType: 'super_admin',
    store: null,
    password: 'x'
  })
  superToken = await signSessionToken(
    { id: opener.id, userName: 'crh_super', roleType: 'super_admin', store: null },
    JWT_SECRET
  )
  regA = await db.cashRegister.create({
    store: storeA.id,
    user: opener.id,
    openingBalance: 100000,
    closingBalance: 100000,
    status: 'closed',
    openedAt: new Date('2026-09-01T10:00:00+07:00'),
    closedAt: new Date('2026-09-01T18:00:00+07:00')
  })
  regB = await db.cashRegister.create({
    store: storeB.id,
    user: opener.id,
    openingBalance: 200000,
    closingBalance: 200000,
    status: 'closed',
    openedAt: new Date('2026-09-02T10:00:00+07:00'),
    closedAt: new Date('2026-09-02T18:00:00+07:00')
  })
})

afterAll(async () => {
  await db.cashRegister
    .destroy({ where: { id: [regA?.id, regB?.id].filter(Boolean) }, force: true })
    .catch(() => {})
  await db.user.destroy({ where: { id: opener?.id }, force: true }).catch(() => {})
  await db.location
    .destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true })
    .catch(() => {})
})

const history = (setCookie) => {
  let r = request(app)
    .get('/cash-register/history')
    .query({ page: 1, limit: 50 })
    .set('Authorization', `Bearer ${superToken}`)
  if (setCookie) r = r.set('Cookie', setCookie)
  return r
}

describe('cash-register history — global super_admin view', () => {
  test('stale activeStore cookie must NOT scope Semua Toko to one store', async () => {
    const res = await history(`activeStore=${storeA.id}`)
    expect(res.status).toBe(200)
    const stores = new Set(res.body.data.map((row) => Number(row.store)))
    expect(stores.has(Number(storeA.id))).toBe(true)
    expect(stores.has(Number(storeB.id))).toBe(true)
  })

  test('no cookie: global view returns both stores', async () => {
    const res = await history(null)
    expect(res.status).toBe(200)
    const stores = new Set(res.body.data.map((row) => Number(row.store)))
    expect(stores.has(Number(storeA.id))).toBe(true)
    expect(stores.has(Number(storeB.id))).toBe(true)
  })

  test('explicit ?store= still scopes to that store', async () => {
    const res = await request(app)
      .get('/cash-register/history')
      .query({ page: 1, limit: 50, store: storeB.id })
      .set('Authorization', `Bearer ${superToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThan(0)
    for (const row of res.body.data) {
      expect(Number(row.store)).toBe(Number(storeB.id))
    }
  })
})
