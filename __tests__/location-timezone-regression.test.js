process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 User-Test Blocker 1 — Add Location / Timezone
// Observed: "column timezone does not exist" on POS → Add Location / Store
// Root cause: production DB missing column `location.timezone` (migration
// 20260922000001-add-timezone-to-location.js not yet applied in prod —
// prod has 32 location columns, dev/test has 33 with timezone). The FE does
// not send timezone (no selector), BE defaults to 'Asia/Jakarta' via model
// default, but Sequelize's INSERT includes the column → 500 if column missing.
// This test proves the application code is correct when the column exists:
// creation without timezone defaults, with explicit timezone stores it, and
// invalid IANA is rejected 400 — not 500. Production must run the pending
// migration separately (infra action).

let superAdminToken = null
let superAdminUser = null
let tenant = null

beforeAll(async () => {
  tenant = await db.tenant.create({
    code: `LOCTZ_${Date.now()}`,
    name: 'LOCTZ Tenant'
  })
  superAdminUser = await db.user.create({
    userName: 'loc_tz_regression_admin_' + Date.now(),
    email: `loc_tz_${Date.now()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active'
  })
  superAdminToken = await signSessionToken(
    { id: superAdminUser.id, userName: superAdminUser.userName, roleType: 'super_admin', store: null },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.location.destroy({ where: { createdBy: superAdminUser?.id }, force: true })
  await db.user.destroy({ where: { id: superAdminUser?.id }, force: true })
  await db.tenant.destroy({ where: { id: tenant?.id }, force: true })
})

const createLocation = (payload) =>
  request(app)
    .post('/location/add-new-location')
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send(payload)

describe('Blocker 1 — Location timezone: creation must not 500 when column exists', () => {
  test('creating a location without explicit timezone defaults to Asia/Jakarta and returns 201, not 500', async () => {
    const unique = `TZ_LOC_DEFAULT_${Date.now()}`
    const res = await createLocation({
      name: unique,
      phoneNumber: '081234567890',
      email: `tz_${Date.now()}@test.com`,
      address: 'Jl. Test No. 1',
      province: '31',
      city: '3171',
      district: '3171010',
      village: '3171010001',
      postalCode: '10110',
      status: 'active',
      tenantId: tenant.id
      // no timezone key — controller uses default
    })
    // Before migration fix this was 500 "column timezone does not exist"
    // After fix (column exists + model default) this is 201 with Asia/Jakarta
    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    const loc = res.body.data
    expect(loc.timezone).toBe('Asia/Jakarta')
    const fresh = await db.location.findByPk(loc.id)
    expect(fresh.timezone).toBe('Asia/Jakarta')
  })

  test('creating a location with explicit valid IANA timezone stores it', async () => {
    const unique = `TZ_LOC_EXPLICIT_${Date.now()}`
    const res = await createLocation({
      name: unique,
      phoneNumber: '081234567891',
      email: `tz_explicit_${Date.now()}@test.com`,
      address: 'Jl. Test No. 2',
      province: '31',
      city: '3171',
      district: '3171010',
      village: '3171010001',
      postalCode: '10110',
      status: 'active',
      tenantId: tenant.id,
      timezone: 'Asia/Jayapura'
    })
    expect(res.status).toBe(201)
    expect(res.body.data.timezone).toBe('Asia/Jayapura')
    const fresh = await db.location.findByPk(res.body.data.id)
    expect(fresh.timezone).toBe('Asia/Jayapura')
  })

  test('creating a location with invalid IANA timezone is rejected 400, not 500', async () => {
    const res = await createLocation({
      name: `TZ_LOC_INVALID_${Date.now()}`,
      phoneNumber: '081234567892',
      email: `tz_invalid_${Date.now()}@test.com`,
      address: 'Jl. Test No. 3',
      province: '31',
      city: '3171',
      district: '3171010',
      village: '3171010001',
      postalCode: '10110',
      status: 'active',
      tenantId: tenant.id,
      timezone: 'WIB' // not IANA — must be Asia/Jakarta etc.
    })
    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    // validation message must mention timezone/ IANA, not generic 500
    const msg = res.body.message || JSON.stringify(res.body)
    expect(msg.toLowerCase()).toMatch(/timezone|iana/)
  })

  test('location model default is Asia/Jakarta when no timezone supplied at ORM level', async () => {
    const loc = await db.location.create(await withTestTenant({
      name: `TZ_ORM_DEFAULT_${Date.now()}`,
      status: 'active',
      createdBy: superAdminUser.id
    }))
    expect(loc.timezone).toBe('Asia/Jakarta')
    await loc.destroy({ force: true })
  })
})
