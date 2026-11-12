process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// E2E 2026-11-11 (F-20): BISA told diners the outlet was closed while the
// POS said nothing. The detail the POS reads carries the same open state
// the QR order endpoint enforces.

const RUN = Date.now()
const everyDay = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
let closedStore
let openStore
let admin
let token

beforeAll(async () => {
  closedStore = await db.location.create({
    name: `DETAIL_CLOSED_${RUN}`,
    status: 'active',
    timezone: 'Asia/Jakarta',
    openingHours: everyDay.map((day) => ({ day, open: null, close: null, is24Hours: false }))
  })
  openStore = await db.location.create({
    name: `DETAIL_OPEN_${RUN}`,
    status: 'active',
    timezone: 'Asia/Jakarta',
    openingHours: everyDay.map((day) => ({ day, open: '00:00', close: '23:59', is24Hours: true }))
  })
  admin = await db.user.create({
    userName: `detail_open_${RUN}`,
    email: `detail_open_${RUN}@test.com`,
    roleType: 'super_admin',
    userType: 'super_admin',
    status: 'active'
  })
  token = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.user.destroy({ where: { id: admin.id }, force: true })
  await db.location.destroy({ where: { id: [closedStore.id, openStore.id] }, force: true })
})

const detail = (id) =>
  request(app)
    .get(`/location/get-location-detail/${id}`)
    .set('Authorization', `Bearer ${token}`)

test('the location detail says whether the outlet is open right now', async () => {
  const closed = await detail(closedStore.id)
  expect(closed.status).toBe(200)
  expect(closed.body.data.openStatus).toMatchObject({ isOpen: false })

  const open = await detail(openStore.id)
  expect(open.status).toBe(200)
  expect(open.body.data.openStatus).toEqual({ isOpen: true, nextOpenAt: null })
})
