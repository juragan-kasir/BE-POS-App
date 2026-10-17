process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken, ensureLocationIds } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let superAdminToken

let adminStore1Token

let adminStore2Token

let userStore1Token

let loc1 = null
let loc2 = null

beforeAll(async () => {
  // AUTH-1 P2: the caller store comes from the DB row; abstract stores must exist.
  await ensureLocationIds(1, 2)
  loc1 = await db.location.create({
    store: 1,
    name: 'ISO_STORE_1',
    address: 'Jl. Isolation 1',
    phoneNumber: '081000000001',
    email: 'iso1@store.com',
    status: 'active'
  })

  loc2 = await db.location.create({
    store: 2,
    name: 'ISO_STORE_2',
    address: 'Jl. Isolation 2',
    phoneNumber: '081000000002',
    email: 'iso2@store.com',
    status: 'active'
  })

  // P1-4: central gate denies unknown caller identities; these rows satisfy
  // the identity invariant. JWT claims (abstract store numbers) and all
  // assertions are unchanged; row store stays null (no FK implication).
  // AUTH-1 P2: the row (not the JWT) is the authority, so each row carries
  // the store its token claims (abstract stores 1/2 exist, see above).
  for (const [id, userName, roleType, userType, store] of [
    [9999, 'superadmin_iso', 'super_admin', 'admin', null],
    [9998, 'admin1_iso', 'admin', 'admin', 1],
    [9997, 'admin2_iso', 'admin', 'admin', 2],
    [9996, 'user1_iso', 'user', 'user', 1]
  ]) {
    await db.user.create({
      id,
      userName,
      email: `p14-${id}-store-isolation@test.com`,
      roleType,
      userType,
      store,
      status: 'active',
      fullName: userName
    })
  }
  // Inline per-test tokens below (ids 9995/9994) also need real rows.
  for (const [id, userName] of [
    [9995, 'admin_loc1_owner'],
    [9994, 'admin_loc1_owner2']
  ]) {
    await db.user.create({
      id,
      userName,
      email: `p14-${id}-store-isolation@test.com`,
      roleType: 'admin',
      userType: 'admin',
      store: loc1.id,
      status: 'active',
      fullName: userName
    })
  }
})

// AUTH-1 P2: tokens bound to real sessions, minted once the users exist.
beforeAll(async () => {
  superAdminToken = await signSessionToken(
  { id: 9999, userName: 'superadmin_iso', roleType: 'super_admin' },
  JWT_SECRET
)
  adminStore1Token = await signSessionToken(
  { id: 9998, userName: 'admin1_iso', roleType: 'admin', store: 1 },
  JWT_SECRET
)
  adminStore2Token = await signSessionToken(
  { id: 9997, userName: 'admin2_iso', roleType: 'admin', store: 2 },
  JWT_SECRET
)
  userStore1Token = await signSessionToken(
  { id: 9996, userName: 'user1_iso', roleType: 'user', store: 1 },
  JWT_SECRET
)
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [9999, 9998, 9997, 9996, 9995, 9994] }, force: true })
  await db.invoice_setting.destroy({
    where: { store: [1, 2] },
    force: true
  })
  await db.location.destroy({
    where: { id: [loc1?.id, loc2?.id].filter(Boolean) },
    force: true
  })
})

describe('Store data isolation — invoice settings', () => {
  test('admin store 1 cannot read store 2 invoice setting', async () => {
    await db.invoice_setting.upsert({
      store: 2,
      showStoreName: false,
      footer: 'Store 2 secret'
    })

    const res = await request(app)
      .get('/invoice/setting?store=2')
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(403)
  })

  test('admin store 1 can read own store invoice setting', async () => {
    await db.invoice_setting.upsert({
      store: 1,
      showStoreName: false,
      footer: 'Store 1 visible'
    })

    const res = await request(app)
      .get('/invoice/setting?store=1')
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.footer).toBe('Store 1 visible')
  })

  test('super_admin can read any store invoice setting', async () => {
    const res = await request(app)
      .get('/invoice/setting?store=2')
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.footer).toBe('Store 2 secret')
  })

  test('admin store 1 cannot update store 2 invoice setting', async () => {
    const res = await request(app)
      .put('/invoice/setting')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ store: 2, showStoreName: false })

    expect(res.status).toBe(403)
  })

  test('admin store 1 cannot reset store 2 invoice setting', async () => {
    const res = await request(app)
      .post('/invoice/setting/reset')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ store: 2 })

    expect(res.status).toBe(403)
  })

  test('super_admin can reset any store invoice setting', async () => {
    await db.invoice_setting.upsert({
      store: 1,
      showStoreName: false,
      footer: 'To be reset'
    })

    const res = await request(app)
      .post('/invoice/setting/reset')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ store: 1 })

    expect(res.status).toBe(200)

    const setting = await db.invoice_setting.findOne({ where: { store: 1 } })
    expect(setting.showStoreName).toBe(true)
    expect(setting.footer).toBe('Terima kasih atas kunjungan Anda')
  })
})

describe('Store data isolation — location', () => {
  test('super_admin can see all locations', async () => {
    const res = await request(app)
      .get('/location/get-location-all')
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(res.status).toBe(200)
    const names = res.body.data.map((l) => l.name)
    expect(names).toContain('ISO_STORE_1')
    expect(names).toContain('ISO_STORE_2')
  })

  test('admin sees only own store location (scoped, no cross-store leak)', async () => {
    const ownToken = await signSessionToken(
      { id: 9995, userName: 'admin_loc1_owner', roleType: 'admin', store: loc1.id },
      JWT_SECRET
    )
    const res = await request(app)
      .get('/location/get-location-all')
      .set('Authorization', `Bearer ${ownToken}`)

    expect(res.status).toBe(200)
    // NOTE: the list endpoint returns display ids (`loc-001`); scope is
    // proven when every row is the caller's own store and nothing else.
    const expected = `loc-${String(loc1.id).padStart(3, '0')}`
    const ids = res.body.data.map((l) => l.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id) => id === expected)).toBe(true)
  })

  // C-7 fix (2026-09-09): getLocationById now pins non-super-admin to their
  // OWN location — a location record's own id IS the tenant's store id, so
  // the caller's JWT `store` claim must equal the requested location's id.
  // adminStore1Token/adminStore2Token carry a hardcoded store:1/store:2
  // claim used throughout this file for unrelated (product/etc) fixtures
  // and are NOT tied to loc1.id/loc2.id's actual (autoincrement) values —
  // these two location-detail tests need their own tokens whose store claim
  // genuinely matches the location under test.
  test('admin store 1 can access own location detail', async () => {
    const ownToken = await signSessionToken(
      { id: 9995, userName: 'admin_loc1_owner', roleType: 'admin', store: loc1.id },
      JWT_SECRET
    )
    const res = await request(app)
      .get(`/location/get-location-detail/${loc1.id}`)
      .set('Authorization', `Bearer ${ownToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('ISO_STORE_1')
  })

  // C-7 fix (2026-09-09): this endpoint used to have NO tenant boundary at
  // all — Location.findByPk(dbId) returned any store's contact/business
  // data (email, managerName, dailyTarget, ...) to any authenticated user.
  // This test previously asserted that gap as correct ("no isolation on
  // this endpoint"); it now asserts the fixed, tenant-scoped contract.
  test('admin store 1 CANNOT access store 2 location detail (C-7 fix)', async () => {
    const ownToken = await signSessionToken(
      { id: 9994, userName: 'admin_loc1_owner2', roleType: 'admin', store: loc1.id },
      JWT_SECRET
    )
    const res = await request(app)
      .get(`/location/get-location-detail/${loc2.id}`)
      .set('Authorization', `Bearer ${ownToken}`)

    expect(res.status).toBe(404)
  })
})

describe('User role restrictions', () => {
  test('user role can read own store invoice setting', async () => {
    await db.invoice_setting.upsert({
      store: 1,
      showStoreName: false,
      footer: 'Store 1 user footer'
    })

    const res = await request(app)
      .get('/invoice/setting?store=1')
      .set('Authorization', `Bearer ${userStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.footer).toBe('Store 1 user footer')
  })

  test('user role cannot read other store invoice setting', async () => {
    await db.invoice_setting.upsert({
      store: 2,
      showStoreName: false,
      footer: 'Store 2 secret'
    })

    const res = await request(app)
      .get('/invoice/setting?store=2')
      .set('Authorization', `Bearer ${userStore1Token}`)

    expect(res.status).toBe(403)
  })

  test('user role cannot update invoice setting for other store', async () => {
    const res = await request(app)
      .put('/invoice/setting')
      .set('Authorization', `Bearer ${userStore1Token}`)
      .send({ store: 2, showStoreName: false })

    expect(res.status).toBe(403)
  })

  test('user role cannot update own store invoice setting (role not allowed)', async () => {
    const res = await request(app)
      .put('/invoice/setting')
      .set('Authorization', `Bearer ${userStore1Token}`)
      .send({ store: 1, showStoreName: false })

    expect(res.status).toBe(403)
  })

  test('user role cannot reset other store invoice setting', async () => {
    const res = await request(app)
      .post('/invoice/setting/reset')
      .set('Authorization', `Bearer ${userStore1Token}`)
      .send({ store: 2 })

    expect(res.status).toBe(403)
  })

  test('user cannot reset own store setting (role not allowed)', async () => {
    await db.invoice_setting.upsert({
      store: 1,
      showStoreName: false,
      footer: 'To be reset'
    })

    const res = await request(app)
      .post('/invoice/setting/reset')
      .set('Authorization', `Bearer ${userStore1Token}`)
      .send({ store: 1 })

    expect(res.status).toBe(403)
  })

  test('user cannot reset other store setting', async () => {
    const res = await request(app)
      .post('/invoice/setting/reset')
      .set('Authorization', `Bearer ${userStore1Token}`)
      .send({ store: 2 })

    expect(res.status).toBe(403)
  })
})