process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store1 = null
let store2 = null
let boundSuper = null
let boundSuperToken = null
let emp1 = null
let emp2 = null
let shift1 = null
let shift2 = null
let swap1 = null
let swap2 = null

beforeAll(async () => {
  store1 = await db.location.create({ name: 'BOUND_SCOPE_STORE_1', status: 'active' })
  store2 = await db.location.create({ name: 'BOUND_SCOPE_STORE_2', status: 'active' })

  boundSuper = await db.user.create({
    id: 99501,
    userName: 'bound_scope_super',
    email: 'bound_scope_super@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: store1.id,
    status: 'active',
    fullName: 'BOUND_SCOPE_SUPER'
  })
  boundSuperToken = await signSessionToken(
    { id: boundSuper.id, userName: boundSuper.userName, roleType: 'super_admin', store: store1.id },
    JWT_SECRET
  )

  emp1 = await db.user.create({
    id: 99502,
    userName: 'bound_scope_emp1',
    email: 'bound_scope_emp1@test.com',
    roleType: 'user',
    userType: 'user',
    store: store1.id,
    status: 'active',
    fullName: 'BOUND_SCOPE_EMP_1'
  })
  emp2 = await db.user.create({
    id: 99503,
    userName: 'bound_scope_emp2',
    email: 'bound_scope_emp2@test.com',
    roleType: 'user',
    userType: 'user',
    store: store2.id,
    status: 'active',
    fullName: 'BOUND_SCOPE_EMP_2'
  })

  shift1 = await db.shift.create({
    store: store1.id,
    name: 'BOUND_SCOPE_SHIFT_1',
    tipe_shift: 'harian',
    startTime: '08:00',
    endTime: '16:00',
    karyawan: [emp1.id],
    status: 'active'
  })
  shift2 = await db.shift.create({
    store: store2.id,
    name: 'BOUND_SCOPE_SHIFT_2',
    tipe_shift: 'harian',
    startTime: '16:00',
    endTime: '00:00',
    karyawan: [emp2.id],
    status: 'active'
  })

  swap1 = await db.shift_swap.create({
    store: store1.id,
    requesterId: emp1.id,
    targetId: boundSuper.id,
    requesterShiftId: shift1.id,
    targetShiftId: shift1.id,
    status: 'pending'
  })
  swap2 = await db.shift_swap.create({
    store: store2.id,
    requesterId: emp2.id,
    targetId: boundSuper.id,
    requesterShiftId: shift2.id,
    targetShiftId: shift2.id,
    status: 'pending'
  })

  const today = new Date()
  await db.attendance.bulkCreate([
    {
      userId: emp1.id,
      store: store1.id,
      shiftId: shift1.id,
      type: 'check-in',
      absenAt: today,
      latitude: -6.2,
      longitude: 106.8,
      accuracy: 10,
      status: 'valid'
    },
    {
      userId: emp2.id,
      store: store2.id,
      shiftId: shift2.id,
      type: 'check-in',
      absenAt: today,
      latitude: -6.3,
      longitude: 106.9,
      accuracy: 10,
      status: 'valid'
    }
  ])
})

afterAll(async () => {
  await db.attendance.destroy({
    where: { userId: [emp1?.id, emp2?.id].filter(Boolean) },
    force: true
  })
  await db.shift_swap.destroy({
    where: { id: [swap1?.id, swap2?.id].filter(Boolean) },
    force: true
  })
  await db.shift.destroy({
    where: { id: [shift1?.id, shift2?.id].filter(Boolean) },
    force: true
  })
  await db.user.destroy({ where: { id: [99501, 99502, 99503] }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
})

describe('store-bound super_admin legacy scope', () => {
  test('shift list only contains own-store shifts', async () => {
    const res = await request(app)
      .get('/shift/get-shift')
      .set('Authorization', `Bearer ${boundSuperToken}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.map((s) => s.id)
    expect(ids).toContain(shift1.id)
    expect(ids).not.toContain(shift2.id)
  })

  test('shift dropdown only contains own-store shifts', async () => {
    const res = await request(app)
      .get('/shift/dropdown')
      .set('Authorization', `Bearer ${boundSuperToken}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.map((s) => s.id)
    expect(ids).toContain(shift1.id)
    expect(ids).not.toContain(shift2.id)
  })

  test('shift detail rejects a foreign-store shift', async () => {
    const res = await request(app)
      .get(`/shift/get-shift/${shift2.id}`)
      .set('Authorization', `Bearer ${boundSuperToken}`)

    expect(res.status).toBe(404)
  })

  test('shift create cannot target another store', async () => {
    const before = await db.shift.count({ where: { store: store2.id } })
    const res = await request(app)
      .post('/shift/add-new-shift')
      .set('Authorization', `Bearer ${boundSuperToken}`)
      .send({
        store: store2.id,
        nama_shift: 'BOUND_SCOPE_FOREIGN_CREATE',
        tipe_shift: 'harian',
        jam_mulai: '08:00',
        jam_selesai: '16:00',
        status: 'active',
        karyawan: []
      })

    expect(res.status).toBe(403)
    expect(await db.shift.count({ where: { store: store2.id } })).toBe(before)
  })

  test('attendance today only contains own-store rows', async () => {
    const res = await request(app)
      .get('/attendance/today')
      .set('Authorization', `Bearer ${boundSuperToken}`)

    expect(res.status).toBe(200)
    const stores = [...new Set(res.body.data.map((r) => r.store))]
    expect(stores).toEqual([store1.id])
  })

  test('attendance by foreign shift returns nothing', async () => {
    const res = await request(app)
      .get(`/attendance/by-shift?shiftId=${shift2.id}`)
      .set('Authorization', `Bearer ${boundSuperToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  test('shift swap list only contains own-store swaps', async () => {
    const res = await request(app)
      .get('/shift-swap/get-swap')
      .set('Authorization', `Bearer ${boundSuperToken}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.map((s) => s.id)
    expect(ids).toContain(swap1.id)
    expect(ids).not.toContain(swap2.id)
  })
})
