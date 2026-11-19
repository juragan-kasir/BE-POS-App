process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 39 Batch 6D — per-day is24Hours flag on location.openingHours.
// Locked rules under test:
//  - is24Hours defaults to false when omitted, never inferred from
//    open === close or any other time comparison.
//  - a closed day stays { open: null, close: null, is24Hours: false }.
//  - legacy rows (JSONB written before this field existed) normalize to
//    is24Hours: false on read, without mutating stored data.
//  - editing a location without sending openingHours leaves the stored
//    schedule (including is24Hours) untouched.

let superAdminToken = null
let superAdminUser = null
let tenant = null

beforeAll(async () => {
  tenant = await db.tenant.create({
    code: `LOC24H_${Date.now()}`,
    name: 'LOC24H Tenant'
  })
  superAdminUser = await db.user.create({
    userName: 'loc_24h_regression_admin_' + Date.now(),
    email: `loc_24h_${Date.now()}@test.com`,
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

const editLocation = (payload) =>
  request(app)
    .put('/location/edit-location')
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send(payload)

const getLocationDetail = (id) =>
  request(app)
    .get(`/location/get-location-detail/${id}`)
    .set('Authorization', `Bearer ${superAdminToken}`)

const basePayload = (overrides = {}) => ({
  name: `LOC24H_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  phoneNumber: '081234567890',
  email: `loc24h_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@test.com`,
  address: 'Jl. Test No. 1',
  province: '31',
  city: '3171',
  district: '3171010',
  village: '3171010001',
  postalCode: '10110',
  status: 'active',
  tenantId: tenant.id,
  ...overrides
})

describe('Batch 6D — location.openingHours is24Hours flag', () => {
  test('creating with is24Hours: true on a day stores and returns it as true', async () => {
    const res = await createLocation(
      basePayload({
        openingHours: [
          { day: 'Monday', open: '00:00', close: '23:59', is24Hours: true }
        ]
      })
    )
    expect(res.status).toBe(201)
    const monday = res.body.data.openingHours.find((d) => d.day === 'Monday')
    expect(monday.is24Hours).toBe(true)

    const fresh = await db.location.findByPk(res.body.data.id)
    expect(fresh.openingHours.find((d) => d.day === 'Monday').is24Hours).toBe(true)
  })

  test('creating with is24Hours omitted defaults to false, not inferred', async () => {
    const res = await createLocation(
      basePayload({
        openingHours: [{ day: 'Tuesday', open: '09:00', close: '21:00' }]
      })
    )
    expect(res.status).toBe(201)
    const tuesday = res.body.data.openingHours.find((d) => d.day === 'Tuesday')
    expect(tuesday.is24Hours).toBe(false)
  })

  test('open === close with is24Hours omitted stays false — never inferred from equal times', async () => {
    const res = await createLocation(
      basePayload({
        openingHours: [{ day: 'Wednesday', open: '00:00', close: '00:00' }]
      })
    )
    expect(res.status).toBe(201)
    const wednesday = res.body.data.openingHours.find((d) => d.day === 'Wednesday')
    expect(wednesday.is24Hours).toBe(false)
  })

  test('a closed day normalizes to { open: null, close: null, is24Hours: false }', async () => {
    const res = await createLocation(
      basePayload({
        openingHours: [{ day: 'Sunday', open: null, close: null }]
      })
    )
    expect(res.status).toBe(201)
    const sunday = res.body.data.openingHours.find((d) => d.day === 'Sunday')
    expect(sunday).toMatchObject({ open: null, close: null, is24Hours: false })
  })

  test('editing a location to set is24Hours: true persists and is returned on re-fetch', async () => {
    const created = await createLocation(
      basePayload({
        openingHours: [{ day: 'Thursday', open: '09:00', close: '21:00', is24Hours: false }]
      })
    )
    expect(created.status).toBe(201)
    const id = created.body.data.id

    const edited = await editLocation({
      id,
      openingHours: [{ day: 'Thursday', open: '00:00', close: '23:59', is24Hours: true }]
    })
    expect(edited.status).toBe(200)

    const detail = await getLocationDetail(id)
    const thursday = detail.body.data.openingHours.find((d) => d.day === 'Thursday')
    expect(thursday.is24Hours).toBe(true)
  })

  test('editing a location WITHOUT sending openingHours leaves the stored schedule untouched', async () => {
    const created = await createLocation(
      basePayload({
        openingHours: [{ day: 'Friday', open: '10:00', close: '18:00', is24Hours: true }]
      })
    )
    expect(created.status).toBe(201)
    const id = created.body.data.id

    const edited = await editLocation({ id, managerName: 'New Manager' })
    expect(edited.status).toBe(200)

    const detail = await getLocationDetail(id)
    const friday = detail.body.data.openingHours.find((d) => d.day === 'Friday')
    expect(friday).toMatchObject({ open: '10:00', close: '18:00', is24Hours: true })
  })

  test('legacy row written without is24Hours normalizes to false on read, without needing a migration', async () => {
    const legacy = await db.location.create(await withTestTenant({
      name: `LOC24H_LEGACY_${Date.now()}`,
      status: 'active',
      createdBy: superAdminUser.id,
      // Simulates data written before this field existed — no is24Hours key.
      openingHours: [{ day: 'Saturday', open: '08:00', close: '17:00' }]
    }))

    const detail = await getLocationDetail(legacy.id)
    expect(detail.status).toBe(200)
    const saturday = detail.body.data.openingHours.find((d) => d.day === 'Saturday')
    expect(saturday).toMatchObject({ open: '08:00', close: '17:00', is24Hours: false })

    await legacy.destroy({ force: true })
  })

  test('a location with no openingHours at all returns the 7-day default, each with is24Hours: false', async () => {
    const created = await createLocation(basePayload())
    expect(created.status).toBe(201)
    const id = created.body.data.id

    await db.location.update({ openingHours: null }, { where: { id } })

    const detail = await getLocationDetail(id)
    expect(detail.status).toBe(200)
    expect(detail.body.data.openingHours).toHaveLength(7)
    for (const day of detail.body.data.openingHours) {
      expect(day.is24Hours).toBe(false)
      expect(day.open).toBeNull()
      expect(day.close).toBeNull()
    }
  })
})
