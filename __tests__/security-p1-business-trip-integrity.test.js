process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store1 = null
let store2 = null
let admin1 = null
let admin2 = null
let foreignAdmin = null
let boundSuper = null
let admin1Token = null
let admin2Token = null
let foreignAdminToken = null
let boundSuperToken = null
let employeeToken = null
let foreignEmployee = null
let selfTrip = null
let foreignTrip = null
let editableTrip = null
let tripSeq = 0

const tripNumber = () => `BT-SEC-${Date.now()}-${++tripSeq}`

beforeAll(async () => {
  store1 = await db.location.create({ name: 'BT_SEC_STORE_1', status: 'active' })
  store2 = await db.location.create({ name: 'BT_SEC_STORE_2', status: 'active' })

  admin1 = await db.user.create({
    id: 99301,
    userName: 'bt_sec_admin1',
    email: 'bt_sec_admin1@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store1.id,
    status: 'active',
    fullName: 'BT_SEC_ADMIN_1'
  })
  admin2 = await db.user.create({
    id: 99302,
    userName: 'bt_sec_admin2',
    email: 'bt_sec_admin2@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store1.id,
    status: 'active',
    fullName: 'BT_SEC_ADMIN_2'
  })
  foreignAdmin = await db.user.create({
    id: 99303,
    userName: 'bt_sec_admin_foreign',
    email: 'bt_sec_admin_foreign@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store2.id,
    status: 'active',
    fullName: 'BT_SEC_ADMIN_FOREIGN'
  })
  boundSuper = await db.user.create({
    id: 99304,
    userName: 'bt_sec_bound_super',
    email: 'bt_sec_bound_super@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: store1.id,
    status: 'active',
    fullName: 'BT_SEC_BOUND_SUPER'
  })
  foreignEmployee = await db.user.create({
    id: 99305,
    userName: 'bt_sec_foreign_employee',
    email: 'bt_sec_foreign_employee@test.com',
    roleType: 'user',
    userType: 'user',
    store: store2.id,
    status: 'active',
    fullName: 'BT_SEC_FOREIGN_EMPLOYEE'
  })

  admin1Token = await signSessionToken(
    { id: admin1.id, userName: admin1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  admin2Token = await signSessionToken(
    { id: admin2.id, userName: admin2.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  foreignAdminToken = await signSessionToken(
    { id: foreignAdmin.id, userName: foreignAdmin.userName, roleType: 'admin', store: store2.id },
    JWT_SECRET
  )
  boundSuperToken = await signSessionToken(
    { id: boundSuper.id, userName: boundSuper.userName, roleType: 'super_admin', store: store1.id },
    JWT_SECRET
  )
  employeeToken = await signSessionToken(
    { id: foreignEmployee.id, userName: foreignEmployee.userName, roleType: 'user', store: store2.id },
    JWT_SECRET
  )

  selfTrip = await db.businessTrip.create({
    tripNumber: tripNumber(),
    store: store1.id,
    status: 'pending',
    destination: 'Bandung',
    departureDate: '2026-11-01',
    returnDate: '2026-11-02',
    createdBy: admin1.id
  })
  foreignTrip = await db.businessTrip.create({
    tripNumber: tripNumber(),
    store: store2.id,
    status: 'pending',
    destination: 'Surabaya',
    departureDate: '2026-11-01',
    returnDate: '2026-11-02',
    createdBy: foreignAdmin.id
  })
  editableTrip = await db.businessTrip.create({
    tripNumber: tripNumber(),
    store: store1.id,
    status: 'draft',
    destination: 'Semarang',
    departureDate: '2026-11-03',
    returnDate: '2026-11-04',
    createdBy: admin2.id
  })
})

afterAll(async () => {
  await db.businessTripBudgetItem.destroy({
    where: { tripId: [selfTrip?.id, foreignTrip?.id, editableTrip?.id].filter(Boolean) },
    force: true
  })
  await db.businessTripEmployee.destroy({
    where: { tripId: [selfTrip?.id, foreignTrip?.id, editableTrip?.id].filter(Boolean) },
    force: true
  })
  await db.businessTrip.destroy({
    where: { id: [selfTrip?.id, foreignTrip?.id, editableTrip?.id].filter(Boolean) },
    force: true
  })
  await db.user.destroy({ where: { id: [99301, 99302, 99303, 99304, 99305] }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
})

describe('business trip integrity', () => {
  test('creator cannot approve their own trip', async () => {
    const res = await request(app)
      .patch(`/business-trip/status/${selfTrip.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({ status: 'approved' })

    expect(res.status).toBe(403)
    const fresh = await db.businessTrip.findByPk(selfTrip.id)
    expect(fresh.status).toBe('pending')
    expect(fresh.approvedBy).toBeNull()
  })

  test('another admin can approve the trip', async () => {
    const res = await request(app)
      .patch(`/business-trip/status/${selfTrip.id}`)
      .set('Authorization', `Bearer ${admin2Token}`)
      .send({ status: 'approved' })

    expect(res.status).toBe(200)
    const fresh = await db.businessTrip.findByPk(selfTrip.id)
    expect(fresh.status).toBe('approved')
    expect(fresh.approvedBy).toBe(admin2.id)
  })

  test('non-manager cannot list business trips', async () => {
    const res = await request(app)
      .get('/business-trip/get-all')
      .set('Authorization', `Bearer ${employeeToken}`)

    expect(res.status).toBe(403)
  })

  test('store-bound super_admin cannot read another store trip', async () => {
    const res = await request(app)
      .get(`/business-trip/get-by-id/${foreignTrip.id}`)
      .set('Authorization', `Bearer ${boundSuperToken}`)

    expect(res.status).toBe(404)
  })

  test('create rejects returnDate before departureDate without writing a row', async () => {
    const before = await db.businessTrip.count()
    const res = await request(app)
      .post('/business-trip/create')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        destination: 'Invalid Dates',
        departureDate: '2026-11-10',
        returnDate: '2026-11-09'
      })

    expect(res.status).toBe(400)
    expect(await db.businessTrip.count()).toBe(before)
  })

  test('update with a foreign employee is rejected without partial writes', async () => {
    const res = await request(app)
      .put(`/business-trip/update/${editableTrip.id}`)
      .set('Authorization', `Bearer ${admin2Token}`)
      .send({
        destination: 'SHOULD_NOT_PERSIST',
        employees: [{ employeeId: foreignEmployee.id, employeeName: 'FOREIGN' }]
      })

    expect(res.status).toBe(400)
    const fresh = await db.businessTrip.findByPk(editableTrip.id)
    expect(fresh.destination).toBe('Semarang')
  })

  test('create rejects negative budget items', async () => {
    const before = await db.businessTrip.count()
    const res = await request(app)
      .post('/business-trip/create')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        destination: 'Negative Budget',
        departureDate: '2026-11-10',
        returnDate: '2026-11-11',
        budgetItems: [{ komponen: 'Hotel', qty: -1, tarif: 100000 }]
      })

    expect(res.status).toBe(400)
    expect(await db.businessTrip.count()).toBe(before)
  })
})
