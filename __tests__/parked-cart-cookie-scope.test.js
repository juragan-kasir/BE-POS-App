process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Same bug class as cash-register/history: a stale `activeStore` cookie must
// not stand in for an explicit store selection. Global super_admin with no
// store anywhere: create => 400, list => unscoped (both stores).

const SUFFIX = Date.now()

let storeA = null
let storeB = null
let opener = null
let superToken = null
const createdIds = []

async function mkCart(storeId, key) {
  const row = await db.parkedCart.create({
    store: storeId,
    createdBy: opener.id,
    cartPayload: { items: [{ name: 'x' }] },
    status: 'active',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    idempotencyKey: `PCC-${key}-${SUFFIX}`
  })
  createdIds.push(row.id)
  return row
}

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: `PCC_STORE_A_${SUFFIX}` }))
  storeB = await db.location.create(await withTestTenant({ name: `PCC_STORE_B_${SUFFIX}` }))
  opener = await db.user.create({
    userName: `pcc_opener_${SUFFIX}`,
    // AUTH-1 P2: authority comes from this row, not the JWT — the caller these
    // tests mean (per the token claims) is a global super_admin.
    roleType: 'super_admin',
    store: null,
    password: 'x'
  })
  superToken = await signSessionToken(
    { id: opener.id, userName: 'pcc_super', roleType: 'super_admin', store: null },
    JWT_SECRET
  )
  await mkCart(storeA.id, 'A')
  await mkCart(storeB.id, 'B')
})

afterAll(async () => {
  await db.parkedCart
    .destroy({ where: { id: createdIds.filter(Boolean) }, force: true })
    .catch(() => {})
  await db.user.destroy({ where: { id: opener?.id }, force: true }).catch(() => {})
  await db.location
    .destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true })
    .catch(() => {})
})

const staleCookie = () => `activeStore=${storeA.id}`
const auth = (r) => r.set('Authorization', `Bearer ${superToken}`)

describe('parked-cart cookie scope', () => {
  test('create without explicit store + stale cookie => 400, no row created', async () => {
    const before = await db.parkedCart.count({ where: { store: storeA.id } })
    const res = await auth(
      request(app)
        .post('/parked-cart/')
        .set('Cookie', staleCookie())
        .send({ cart: { items: [{ name: 'probe' }] }, idempotencyKey: `PCC-PROBE-${SUFFIX}` })
    )
    expect(res.status).toBe(400)
    const after = await db.parkedCart.count({ where: { store: storeA.id } })
    expect(after).toBe(before)
  })

  test('list without explicit store + stale cookie => both stores', async () => {
    const res = await auth(request(app).get('/parked-cart/').set('Cookie', staleCookie()))
    expect(res.status).toBe(200)
    const stores = new Set((res.body.data || []).map((row) => Number(row.store)))
    expect(stores.has(Number(storeA.id))).toBe(true)
    expect(stores.has(Number(storeB.id))).toBe(true)
  })
})
