process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken, ensureLocationIds } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let superAdminToken

let adminStore1Token

let adminStore2Token

let locationStore1 = null
let locationStore2 = null

beforeAll(async () => {
  // AUTH-1 P2: the caller store comes from the DB row; abstract stores must exist.
  await ensureLocationIds(1, 2)
  locationStore1 = await db.location.create(await withTestTenant({
    store: 1,
    name: 'TEST_STORE_INVOICE_1',
    address: 'Jl. Test 1',
    phoneNumber: '0811111111',
    email: 'test1@store.com',
    status: 'active'
  }))

  locationStore2 = await db.location.create(await withTestTenant({
    store: 2,
    name: 'TEST_STORE_INVOICE_2',
    address: 'Jl. Test 2',
    phoneNumber: '0822222222',
    email: 'test2@store.com',
    status: 'active'
  }))

  // P1-4: central gate denies unknown caller identities; these rows satisfy
  // the identity invariant. JWT claims (abstract store numbers) and all
  // assertions are unchanged; row store stays null (no FK implication).
  await db.user.create({
    id: 9999,
    userName: 'superadmin',
    email: 'p14-9999-invoice-setting@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'superadmin'
  })
  await db.user.create({
    id: 9998,
    userName: 'admin1',
    email: 'p14-9998-invoice-setting@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: 1,
    status: 'active',
    fullName: 'admin1'
  })
  await db.user.create({
    id: 9997,
    userName: 'admin2',
    email: 'p14-9997-invoice-setting@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: 2,
    status: 'active',
    fullName: 'admin2'
  })
})

// AUTH-1 P2: tokens bound to real sessions, minted once the users exist.
beforeAll(async () => {
  superAdminToken = await signSessionToken(
  { id: 9999, userName: 'superadmin', roleType: 'super_admin' },
  JWT_SECRET
)
  adminStore1Token = await signSessionToken(
  { id: 9998, userName: 'admin1', roleType: 'admin', store: 1 },
  JWT_SECRET
)
  adminStore2Token = await signSessionToken(
  { id: 9997, userName: 'admin2', roleType: 'admin', store: 2 },
  JWT_SECRET
)
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [9999, 9998, 9997] }, force: true })
  await db.invoice_setting.destroy({
    where: { store: [1, 2] },
    force: true
  })
  await db.location.destroy({
    where: { id: [locationStore1?.id, locationStore2?.id].filter(Boolean) },
    force: true
  })
})

describe('GET /invoice/setting — get invoice setting per store', () => {
  test('returns default setting when no setting exists for store', async () => {
    await db.invoice_setting.destroy({ where: { store: 1 }, force: true })

    const res = await request(app)
      .get('/invoice/setting?store=1')
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.isDefault).toBe(true)
    expect(res.body.data.showStoreName).toBe(true)
    expect(res.body.data.showAddress).toBe(true)
    expect(res.body.data.showMemberInfo).toBe(true)
    expect(res.body.data.showLogo).toBe(true)
    expect(res.body.data.footer).toBe('Terima kasih atas kunjungan Anda')
  })

  test('returns default setting for store 2 when no setting exists', async () => {
    const res = await request(app)
      .get('/invoice/setting?store=2')
      .set('Authorization', `Bearer ${adminStore2Token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.isDefault).toBe(true)
  })

  test('returns 401 without token', async () => {
    const res = await request(app).get('/invoice/setting?store=1')
    expect(res.status).toBe(401)
  })
})

describe('PUT /invoice/setting — update invoice setting', () => {
  test('admin store 1 can update own store invoice setting', async () => {
    const res = await request(app)
      .put('/invoice/setting')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({
        store: 1,
        showStoreName: false,
        showAddress: true,
        showMemberInfo: false,
        showLogo: true,
        footer: 'Custom footer from store 1'
      })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.showStoreName).toBe(false)
    expect(res.body.data.showMemberInfo).toBe(false)
    expect(res.body.data.footer).toBe('Custom footer from store 1')
  })

  test('admin store 1 cannot update store 2 invoice setting', async () => {
    const res = await request(app)
      .put('/invoice/setting')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({
        store: 2,
        showStoreName: false
      })

    expect(res.status).toBe(403)
  })

  test('super_admin can update any store invoice setting', async () => {
    const res = await request(app)
      .put('/invoice/setting')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        store: 2,
        showStoreName: false,
        showLogo: false,
        footer: 'Super admin custom footer'
      })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.showStoreName).toBe(false)
    expect(res.body.data.showLogo).toBe(false)
    expect(res.body.data.footer).toBe('Super admin custom footer')
  })

  test('update setting with logo removal', async () => {
    const res = await request(app)
      .put('/invoice/setting')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        store: 1,
        removeLogo: 'true'
      })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })
})

describe('POST /invoice/setting/reset — reset invoice setting to default', () => {
  test('admin store 1 can reset own store setting', async () => {
    await db.invoice_setting.upsert({
      store: 1,
      showStoreName: false,
      showAddress: false,
      footer: 'Custom footer'
    })

    const res = await request(app)
      .post('/invoice/setting/reset')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ store: 1 })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const setting = await db.invoice_setting.findOne({ where: { store: 1 } })
    expect(setting.showStoreName).toBe(true)
    expect(setting.showAddress).toBe(true)
    expect(setting.footer).toBe('Terima kasih atas kunjungan Anda')
  })

  test('admin store 1 cannot reset store 2 setting', async () => {
    await db.invoice_setting.upsert({
      store: 2,
      showStoreName: false,
      footer: 'Store 2 custom'
    })

    const res = await request(app)
      .post('/invoice/setting/reset')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ store: 2 })

    expect(res.status).toBe(403)
  })

  test('super_admin can reset any store setting', async () => {
    const res = await request(app)
      .post('/invoice/setting/reset')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ store: 2 })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const setting = await db.invoice_setting.findOne({ where: { store: 2 } })
    expect(setting.showStoreName).toBe(true)
  })

  test('reset with multiple stores', async () => {
    await db.invoice_setting.upsert({
      store: 1,
      showStoreName: false,
      footer: 'Store 1 custom'
    })
    await db.invoice_setting.upsert({
      store: 2,
      showStoreName: false,
      footer: 'Store 2 custom'
    })

    const res = await request(app)
      .post('/invoice/setting/reset')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ stores: [1, 2] })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const setting1 = await db.invoice_setting.findOne({ where: { store: 1 } })
    const setting2 = await db.invoice_setting.findOne({ where: { store: 2 } })
    expect(setting1.showStoreName).toBe(true)
    expect(setting2.showStoreName).toBe(true)
  })

  test('reset with no stores selected returns 400', async () => {
    const res = await request(app)
      .post('/invoice/setting/reset')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ stores: [] })

    expect(res.status).toBe(400)
  })
})

describe('Invoice setting data isolation', () => {
  test('admin store 1 cannot read store 2 invoice setting via store param', async () => {
    await db.invoice_setting.upsert({
      store: 2,
      showStoreName: false,
      footer: 'Store 2 secret footer'
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
      footer: 'Store 1 footer'
    })

    const res = await request(app)
      .get('/invoice/setting?store=1')
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.footer).toBe('Store 1 footer')
  })
})