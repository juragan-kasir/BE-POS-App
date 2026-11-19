process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Same bug class as getHistory: a stale `activeStore` cookie must not stand
// in for an explicit store selection on cash-register write/read endpoints.
// Global super_admin with no store anywhere must get 400 (explicit selection
// required), never a silent write/read in the cookie's store.

const SUFFIX = Date.now()

let storeA = null
let storeB = null
let storeC = null
let storeD = null
let storeE = null
let opener = null
let superToken = null
const createdRegisterIds = []

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: `CRC_STORE_A_${SUFFIX}` }))
  storeB = await db.location.create(await withTestTenant({ name: `CRC_STORE_B_${SUFFIX}` }))
  // storeC: dedicated to the close test — stores B may already hold an open
  // register from the explicit-store positive control (single-open-register
  // partial unique index would reject a second one).
  storeC = await db.location.create(await withTestTenant({ name: `CRC_STORE_C_${SUFFIX}` }))
  // storeD/E: dedicated open registers for the open-registers global test.
  storeD = await db.location.create(await withTestTenant({ name: `CRC_STORE_D_${SUFFIX}` }))
  storeE = await db.location.create(await withTestTenant({ name: `CRC_STORE_E_${SUFFIX}` }))
  opener = await db.user.create({
    userName: `crc_opener_${SUFFIX}`,
    // AUTH-1 P2: authority comes from this row, not the JWT — the caller these
    // tests mean (per the token claims) is a global super_admin.
    roleType: 'super_admin',
    store: null,
    password: 'x'
  })
  superToken = await signSessionToken(
    { id: opener.id, userName: 'crc_super', roleType: 'super_admin', store: null },
    JWT_SECRET
  )
  for (const s of [storeD, storeE]) {
    const reg = await db.cashRegister.create({
      store: s.id,
      user: opener.id,
      openingBalance: 10000,
      status: 'open',
      openedAt: new Date()
    })
    createdRegisterIds.push(reg.id)
  }
})

afterAll(async () => {
  await db.cashRegister
    .destroy({ where: { id: createdRegisterIds.filter(Boolean) }, force: true })
    .catch(() => {})
  await db.user.destroy({ where: { id: opener?.id }, force: true }).catch(() => {})
  await db.location
    .destroy({
      where: { id: [storeA?.id, storeB?.id, storeC?.id, storeD?.id, storeE?.id].filter(Boolean) },
      force: true
    })
    .catch(() => {})
})

const staleCookie = () => `activeStore=${storeA.id}`
const auth = (r) => r.set('Authorization', `Bearer ${superToken}`)

describe('cash-register cookie scope', () => {
  test('open without explicit store + stale cookie => 400, no row created', async () => {
    const before = await db.cashRegister.count({ where: { store: storeA.id } })
    const res = await auth(
      request(app).post('/cash-register/open').set('Cookie', staleCookie()).send({})
    )
    expect(res.status).toBe(400)
    const after = await db.cashRegister.count({ where: { store: storeA.id } })
    expect(after).toBe(before)
  })

  test('open with explicit body store still works', async () => {
    const res = await auth(
      request(app)
        .post('/cash-register/open')
        .set('Cookie', staleCookie())
        .send({ store: storeB.id, openingBalance: 50000 })
    )
    expect(res.status).toBe(201)
    expect(Number(res.body.data.store)).toBe(Number(storeB.id))
    createdRegisterIds.push(res.body.data.id)
  })

  test('getCurrent without explicit store + stale cookie => 400', async () => {
    const res = await auth(
      request(app).get('/cash-register/current').set('Cookie', staleCookie())
    )
    expect(res.status).toBe(400)
  })

  test('table-reset-preview without explicit store + stale cookie => 400', async () => {
    const res = await auth(
      request(app).get('/cash-register/table-reset-preview').set('Cookie', staleCookie())
    )
    expect(res.status).toBe(400)
  })

  test('close without explicit store + stale cookie => 400', async () => {
    const target = await db.cashRegister.create({
      store: storeC.id,
      user: opener.id,
      openingBalance: 10000,
      status: 'open',
      openedAt: new Date()
    })
    createdRegisterIds.push(target.id)
    const res = await auth(
      request(app)
        .put(`/cash-register/close/${target.id}`)
        .set('Cookie', staleCookie())
        .send({ closingBalance: 10000 })
    )
    expect(res.status).toBe(400)
    await db.cashRegister.destroy({ where: { id: target.id }, force: true }).catch(() => {})
  })

  test('open-registers without explicit store + stale cookie => both stores', async () => {
    const res = await auth(
      request(app).get('/cash-register/open-registers').set('Cookie', staleCookie())
    )
    expect(res.status).toBe(200)
    const stores = new Set((res.body.data || []).map((row) => Number(row.store)))
    expect(stores.has(Number(storeD.id))).toBe(true)
    expect(stores.has(Number(storeE.id))).toBe(true)
  })

  test('x-report without explicit store + stale cookie => 400', async () => {
    const res = await auth(
      request(app).get('/cash-register/x-report').set('Cookie', staleCookie())
    )
    expect(res.status).toBe(400)
  })
})
