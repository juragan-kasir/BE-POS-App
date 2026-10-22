process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store
let admin
let staffA
let staffB
let targetA
let targetB
let staffAToken
let adminToken
let shiftA
let shiftATarget
let shiftB
let shiftBTarget
let swapA
let swapB

const unique = (label) => `P2PRIV_${label}_${SUFFIX}`

const makeUser = (label, roleType, storeId) =>
  db.user.create({
    userName: unique(label),
    email: `${unique(label)}@private.test`,
    phoneNumber: '081200000000',
    userType: 'user',
    roleType,
    store: storeId,
    status: 'active',
    password: 'x'
  })

const makeShift = (label, memberId) =>
  db.shift.create({
    name: unique(label),
    store: store.id,
    startTime: '08:00:00',
    endTime: '16:00:00',
    karyawan: [memberId],
    status: 'active'
  })

const makeSwap = (requesterId, targetId, requesterShiftId, targetShiftId) =>
  db.shift_swap.create({
    requesterId,
    targetId,
    requesterShiftId,
    targetShiftId,
    store: store.id,
    status: 'pending'
  })

beforeAll(async () => {
  store = await db.location.create({ name: unique('STORE'), status: 'active' })
  admin = await makeUser('admin', 'admin', store.id)
  staffA = await makeUser('staff_a', 'user', store.id)
  staffB = await makeUser('staff_b', 'user', store.id)
  targetA = await makeUser('target_a', 'user', store.id)
  targetB = await makeUser('target_b', 'user', store.id)

  staffAToken = await signSessionToken(
    { id: staffA.id, userName: staffA.userName, roleType: 'user', store: store.id },
    JWT_SECRET
  )
  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )

  shiftA = await makeShift('shift_a', staffA.id)
  shiftATarget = await makeShift('shift_a_target', targetA.id)
  shiftB = await makeShift('shift_b', staffB.id)
  shiftBTarget = await makeShift('shift_b_target', targetB.id)

  swapA = await makeSwap(staffA.id, targetA.id, shiftA.id, shiftATarget.id)
  swapB = await makeSwap(staffB.id, targetB.id, shiftB.id, shiftBTarget.id)
})

afterAll(async () => {
  await db.shift_swap.destroy({ where: { store: store?.id }, force: true }).catch(() => {})
  await db.user.destroy({ where: { store: store?.id }, force: true }).catch(() => {})
  await db.shift.destroy({ where: { store: store?.id }, force: true }).catch(() => {})
  await db.location.destroy({ where: { id: store?.id }, force: true }).catch(() => {})
})

const listSwaps = (token, query = '') =>
  request(app)
    .get(`/shift-swap/get-swap${query}`)
    .set('Authorization', `Bearer ${token}`)

describe('shift swap read privacy', () => {
  test('a staff account only receives swaps it participates in', async () => {
    const res = await listSwaps(staffAToken)

    expect(res.status).toBe(200)
    const ids = res.body.data.map((row) => row.id)
    expect(ids).toContain(swapA.id)
    expect(ids).not.toContain(swapB.id)
  })

  test('staff responses do not expose colleague email or phone numbers', async () => {
    const res = await listSwaps(staffAToken)

    expect(res.status).toBe(200)
    for (const row of res.body.data) {
      expect(row.requesterUser).not.toHaveProperty('email')
      expect(row.requesterUser).not.toHaveProperty('phoneNumber')
      expect(row.targetUser).not.toHaveProperty('email')
      expect(row.targetUser).not.toHaveProperty('phoneNumber')
    }
  })

  test('an admin still receives store-wide swaps with contact details', async () => {
    const res = await listSwaps(adminToken)

    expect(res.status).toBe(200)
    const ids = res.body.data.map((row) => row.id)
    expect(ids).toEqual(expect.arrayContaining([swapA.id, swapB.id]))
    expect(res.body.data[0].requesterUser).toHaveProperty('email')
    expect(res.body.data[0].requesterUser).toHaveProperty('phoneNumber')
  })
})
