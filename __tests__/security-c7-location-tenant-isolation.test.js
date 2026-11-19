process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA, storeB, tokenA, tokenB, superToken

describe('C-7 location detail — tenant isolation', () => {
  beforeAll(async () => {
    storeA = await db.location.create(await withTestTenant({
      name: 'C7_STORE_A',
      status: 'active',
      phoneNumber: '111-AAA',
      email: 'storeA-canary@example.com',
      managerName: 'Manager A Canary',
      dailyTarget: 111111
    }))
    storeB = await db.location.create(await withTestTenant({
      name: 'C7_STORE_B',
      status: 'active',
      phoneNumber: '222-BBB',
      email: 'storeB-canary@example.com',
      managerName: 'Manager B Canary',
      dailyTarget: 222222
    }))


    // P1-4: central gate denies unknown caller identities; these rows give
    // the caller ids real identities. Assertions below are unchanged.
    for (const [id, userName, roleType, userType, store] of [
      [88801, 'c7_admin_a', 'admin', 'admin', storeA.id],
      [88802, 'c7_admin_b', 'admin', 'admin', storeB.id],
      [88803, 'c7_super', 'super_admin', 'admin', null]
    ]) {
      await db.user.create({
        id,
        userName,
        email: `p14-${id}-c7@test.com`,
        roleType,
        userType,
        store,
        status: 'active',
        fullName: userName
      })
    }
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
    tokenA = await signSessionToken(
      { id: 88801, userName: 'c7_admin_a', roleType: 'admin', store: storeA.id },
      JWT_SECRET
    )
    tokenB = await signSessionToken(
      { id: 88802, userName: 'c7_admin_b', roleType: 'admin', store: storeB.id },
      JWT_SECRET
    )
    superToken = await signSessionToken(
      { id: 88803, userName: 'c7_super', roleType: 'super_admin', store: null },
      JWT_SECRET
    )
  })

  afterAll(async () => {
    await db.user.destroy({ where: { id: [88801, 88802, 88803] }, force: true })
    await db.location.destroy({ where: { id: [storeA.id, storeB.id] }, force: true })
  })

  test('store A admin CANNOT read store B location detail (no canary leak)', async () => {
    const res = await request(app)
      .get(`/location/get-location-detail/loc-${storeB.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).not.toBe(200)
    expect(JSON.stringify(res.body)).not.toContain('storeB-canary@example.com')
    expect(JSON.stringify(res.body)).not.toContain('Manager B Canary')
    expect(JSON.stringify(res.body)).not.toContain('222222')
  })

  test('store B admin CANNOT read store A location detail (no canary leak)', async () => {
    const res = await request(app)
      .get(`/location/get-location-detail/loc-${storeA.id}`)
      .set('Authorization', `Bearer ${tokenB}`)

    expect(res.status).not.toBe(200)
    expect(JSON.stringify(res.body)).not.toContain('storeA-canary@example.com')
  })

  test('store A admin CAN read its own location detail', async () => {
    const res = await request(app)
      .get(`/location/get-location-detail/loc-${storeA.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)
    expect(res.body?.data?.email).toBe('storeA-canary@example.com')
  })

  test('store B admin CAN read its own location detail', async () => {
    const res = await request(app)
      .get(`/location/get-location-detail/loc-${storeB.id}`)
      .set('Authorization', `Bearer ${tokenB}`)

    expect(res.status).toBe(200)
    expect(res.body?.data?.email).toBe('storeB-canary@example.com')
  })

  test('super_admin CAN read any store location detail (global access preserved)', async () => {
    const resA = await request(app)
      .get(`/location/get-location-detail/loc-${storeA.id}`)
      .set('Authorization', `Bearer ${superToken}`)
    const resB = await request(app)
      .get(`/location/get-location-detail/loc-${storeB.id}`)
      .set('Authorization', `Bearer ${superToken}`)

    expect(resA.status).toBe(200)
    expect(resA.body?.data?.email).toBe('storeA-canary@example.com')
    expect(resB.status).toBe(200)
    expect(resB.body?.data?.email).toBe('storeB-canary@example.com')
  })

  test('nonexistent location id returns 404, not a leak of any other store', async () => {
    const res = await request(app)
      .get('/location/get-location-detail/loc-999999999')
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(404)
  })

  test('malformed location id is handled safely (no crash, no cross-tenant leak)', async () => {
    const res = await request(app)
      .get('/location/get-location-detail/loc-not-a-number')
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).not.toBe(200)
  })
})
