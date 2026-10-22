process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store1
let store2
let requester
let target
let other
let requesterToken
let shiftRequester
let shiftTarget
let shiftOther
let foreignShift

const unique = (label) => `P1SWAP_${label}_${SUFFIX}`
let employeeSeq = 0

const makeEmployee = (storeId) => {
  const key = `${unique('emp')}_${++employeeSeq}`
  return db.user.create({
    userName: key,
    email: `${key}@test.com`,
    userType: 'user',
    roleType: 'kasir',
    store: storeId,
    status: 'active',
    password: 'x'
  })
}

beforeAll(async () => {
  store1 = await db.location.create({ name: unique('STORE_1'), status: 'active' })
  store2 = await db.location.create({ name: unique('STORE_2'), status: 'active' })

  requester = await db.user.create({
    userName: unique('requester'),
    email: `${unique('requester')}@test.com`,
    userType: 'user',
    roleType: 'kasir',
    store: store1.id,
    status: 'active',
    password: 'x'
  })
  target = await makeEmployee(store1.id)
  other = await makeEmployee(store1.id)

  requesterToken = await signSessionToken(
    { id: requester.id, userName: requester.userName, roleType: 'kasir', store: store1.id },
    JWT_SECRET
  )

  const shiftAttrs = (name, storeId, memberId) => ({
    name: unique(name),
    store: storeId,
    startTime: '08:00:00',
    endTime: '16:00:00',
    karyawan: [memberId],
    status: 'active'
  })

  shiftRequester = await db.shift.create(shiftAttrs('SHIFT_REQ', store1.id, requester.id))
  shiftTarget = await db.shift.create(shiftAttrs('SHIFT_TGT', store1.id, target.id))
  shiftOther = await db.shift.create(shiftAttrs('SHIFT_OTHER', store1.id, other.id))
  foreignShift = await db.shift.create(shiftAttrs('SHIFT_FOREIGN', store2.id, target.id))
})

afterAll(async () => {
  await db.shift_swap
    .destroy({ where: { store: [store1?.id, store2?.id].filter(Boolean) }, force: true })
    .catch(() => {})
  await db.user
    .destroy({ where: { store: [store1?.id, store2?.id].filter(Boolean) }, force: true })
    .catch(() => {})
  await db.shift
    .destroy({ where: { store: [store1?.id, store2?.id].filter(Boolean) }, force: true })
    .catch(() => {})
  await db.location
    .destroy({ where: { id: [store1?.id, store2?.id].filter(Boolean) }, force: true })
    .catch(() => {})
})

const createSwap = (overrides = {}) =>
  request(app)
    .post('/shift-swap/create-swap')
    .set('Authorization', `Bearer ${requesterToken}`)
    .send({
      requesterId: requester.id,
      targetId: target.id,
      requesterShiftId: shiftRequester.id,
      targetShiftId: shiftTarget.id,
      ...overrides
    })

describe('shift swap request integrity', () => {
  test('a staff caller cannot create a swap on behalf of another employee', async () => {
    const res = await createSwap({
      requesterId: other.id,
      requesterShiftId: shiftOther.id
    })

    expect(res.status).toBe(403)

    const count = await db.shift_swap.count({
      where: { requesterId: other.id, targetId: target.id, status: 'pending' }
    })
    expect(count).toBe(0)
  })

  test('the requester shift must belong to the requester', async () => {
    const res = await createSwap({
      requesterShiftId: shiftTarget.id,
      targetShiftId: shiftOther.id
    })

    expect(res.status).toBe(400)
  })

  test('the target shift must belong to the target and the same store', async () => {
    const res = await createSwap({ targetShiftId: foreignShift.id })

    expect(res.status).toBe(403)
  })

  test('a staff caller can still create a valid same-store swap for themselves', async () => {
    const res = await createSwap()

    expect(res.status).toBe(201)
  })
})
