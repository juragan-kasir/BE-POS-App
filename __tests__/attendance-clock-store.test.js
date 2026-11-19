process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let ownStore = null
let otherStore = null
let employee = null
let employeeStore1Token = null

beforeAll(async () => {
  // `store` FKs to location.id — create two real locations so the spoof
  // attempt below targets a genuinely different, valid store. attendance.userId
  // FKs to user.id, so the token subject needs a real user row too.
  const suffix = Date.now()
  ownStore = await db.location.create(await withTestTenant({ name: `ATT_OWN_STORE_${suffix}`, status: 'active' }))
  otherStore = await db.location.create(await withTestTenant({ name: `ATT_OTHER_STORE_${suffix}`, status: 'active' }))
  employee = await db.user.create({
    userName: `employee_store1_att_${suffix}`,
    email: `employee_store1_att_${suffix}@test.com`,
    roleType: 'user',
    userType: 'user',
    store: ownStore.id,
    status: 'active'
  })

  employeeStore1Token = await signSessionToken(
    {
      id: employee.id,
      userName: employee.userName,
      roleType: 'user',
      store: ownStore.id
    },
    JWT_SECRET
  )
})

afterAll(async () => {
  if (employee?.id) {
    await db.attendance.destroy({ where: { userId: employee.id }, force: true })
    await db.user.destroy({ where: { id: employee.id }, force: true })
  }
  const locIds = [ownStore?.id, otherStore?.id].filter(Boolean)
  if (locIds.length > 0) {
    await db.location.destroy({
      where: { id: locIds },
      force: true
    })
  }
})

// Regression test: /attendance/clock used to resolve the clock-in store from
// req.body.storeId/store (or a cookie) before falling back to the
// authenticated user's own store, so a client could clock in against a
// store they don't work at.
describe('attendance clock-in store spoofing regression', () => {
  test('clock-in store always comes from the JWT, ignoring a spoofed body.store', async () => {
    const res = await request(app)
      .post('/attendance/clock')
      .set('Authorization', `Bearer ${employeeStore1Token}`)
      .send({
        type: 'check-in',
        store: otherStore.id, // attempted spoof to a real, different store
        latitude: -6.2,
        longitude: 106.8,
        accuracy: 20
      })

    expect(res.status).toBe(201)
    expect(res.body.data.store).toBe(ownStore.id)
  })
})
