process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

const STORE_LAT = -6.2
const STORE_LNG = 106.8

let store1 = null
let storeNoCoords = null
let nearUser = null
let farUser = null
let noCoordUser = null
let nearToken = null
let farToken = null
let noCoordToken = null

beforeAll(async () => {
  store1 = await db.location.create({
    name: 'GEOFENCE_STORE_1',
    status: 'active',
    latitude: STORE_LAT,
    longitude: STORE_LNG
  })
  storeNoCoords = await db.location.create({
    name: 'GEOFENCE_STORE_NO_COORDS',
    status: 'active'
  })

  nearUser = await db.user.create({
    id: 99121,
    userName: 'geofence_near',
    email: 'geofence_near@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store1.id,
    status: 'active',
    fullName: 'GEOFENCE_NEAR'
  })
  farUser = await db.user.create({
    id: 99122,
    userName: 'geofence_far',
    email: 'geofence_far@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store1.id,
    status: 'active',
    fullName: 'GEOFENCE_FAR'
  })
  noCoordUser = await db.user.create({
    id: 99123,
    userName: 'geofence_no_coords',
    email: 'geofence_no_coords@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: storeNoCoords.id,
    status: 'active',
    fullName: 'GEOFENCE_NO_COORDS'
  })

  nearToken = await signSessionToken(
    { id: nearUser.id, userName: nearUser.userName, roleType: 'kasir', store: store1.id },
    JWT_SECRET
  )
  farToken = await signSessionToken(
    { id: farUser.id, userName: farUser.userName, roleType: 'kasir', store: store1.id },
    JWT_SECRET
  )
  noCoordToken = await signSessionToken(
    { id: noCoordUser.id, userName: noCoordUser.userName, roleType: 'kasir', store: storeNoCoords.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.attendance.destroy({
    where: { userId: [99121, 99122, 99123] },
    force: true
  })
  await db.user.destroy({ where: { id: [99121, 99122, 99123] }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, storeNoCoords?.id].filter(Boolean) },
    force: true
  })
})

describe('attendance store geofence', () => {
  test('clock-in near the store succeeds', async () => {
    const res = await request(app)
      .post('/attendance/clock')
      .set('Authorization', `Bearer ${nearToken}`)
      .send({
        type: 'check-in',
        latitude: STORE_LAT + 0.0005,
        longitude: STORE_LNG + 0.0005,
        accuracy: 10
      })

    expect(res.status).toBe(201)
    expect(res.body.data.store).toBe(store1.id)
    expect(res.body.data.status).toBe('valid')
  })

  test('clock-in far from the store is rejected and not recorded', async () => {
    const res = await request(app)
      .post('/attendance/clock')
      .set('Authorization', `Bearer ${farToken}`)
      .send({
        type: 'check-in',
        latitude: STORE_LAT + 0.05,
        longitude: STORE_LNG + 0.05,
        accuracy: 10
      })

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/radius toko/i)
    const count = await db.attendance.count({ where: { userId: farUser.id } })
    expect(count).toBe(0)
  })

  test('store without coordinates keeps existing behavior', async () => {
    const res = await request(app)
      .post('/attendance/clock')
      .set('Authorization', `Bearer ${noCoordToken}`)
      .send({
        type: 'check-in',
        latitude: STORE_LAT + 0.05,
        longitude: STORE_LNG + 0.05,
        accuracy: 10
      })

    expect(res.status).toBe(201)
  })
})
