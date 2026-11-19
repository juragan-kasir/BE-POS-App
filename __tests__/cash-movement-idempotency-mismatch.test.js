process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-IDEM-1 (cash movement): same-key retries carrying a different payload
// must not silently replay the winner. Canonical identity = movement type
// + amount (direction and magnitude of the money movement); reason
// codes/notes are not part of it.

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let adminToken = null
let registerId = null

async function openRegister() {
  const res = await request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ openingBalance: 100000, shift: 1 })
  if (res.status !== 201) throw new Error('register setup failed: ' + JSON.stringify(res.body))
  return res.body.data.id
}

async function postMovement(register, body) {
  return request(app)
    .post(`/cash-register/${register}/movement`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      type: 'cash_in',
      reasonCode: 'float_topup',
      amount: 50000,
      ...body
    })
}

async function movementCount(register, key) {
  return db.cashMovement.count({ where: { cashRegisterId: register, idempotencyKey: key } })
}

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: `CMIDEM_STORE_${Date.now()}`, status: 'active' }))
  const adminUser = await db.user.create({
    userName: `admin_cmidem_${Date.now()}`,
    email: `admin_cmidem_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  registerId = await openRegister()
})

afterAll(async () => {
  await db.cashMovement.destroy({ where: {}, force: true })
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F-IDEM-1 cash-movement payload mismatch', () => {
  test('A — same key + same payload replays without a second movement', async () => {
    const key = unique('cmA')
    const first = await postMovement(registerId, { idempotencyKey: key })
    expect(first.status).toBe(201)

    const retry = await postMovement(registerId, { idempotencyKey: key, notes: 'retry note' })
    expect(retry.status).toBe(200)
    expect(retry.body?.data?.id).toBe(first.body?.data?.id)
    expect(await movementCount(registerId, key)).toBe(1)
  })

  test('B — same key + different amount is rejected without a second movement', async () => {
    const key = unique('cmB')
    const first = await postMovement(registerId, { idempotencyKey: key, amount: 50000 })
    expect(first.status).toBe(201)

    const retry = await postMovement(registerId, { idempotencyKey: key, amount: 60000 })
    expect(retry.status).toBe(409)
    expect(await movementCount(registerId, key)).toBe(1)
  })

  test('B2 — same key + same amount but opposite type is rejected', async () => {
    const key = unique('cmB2')
    const first = await postMovement(registerId, { idempotencyKey: key, type: 'cash_in', amount: 10000 })
    expect(first.status).toBe(201)

    const retry = await postMovement(registerId, { idempotencyKey: key, type: 'cash_out', amount: 10000 })
    expect(retry.status).toBe(409)
    expect(await movementCount(registerId, key)).toBe(1)
  })

  test('C — concurrent same-key requests create exactly one movement', async () => {
    const key = unique('cmC')
    const payload = { idempotencyKey: key, amount: 7000 }
    const [r1, r2] = await Promise.all([
      postMovement(registerId, payload),
      postMovement(registerId, payload)
    ])
    expect([r1.status, r2.status].sort()).toEqual([200, 201])
    expect(await movementCount(registerId, key)).toBe(1)
  })

  test('D — different keys create independent movements', async () => {
    const r1 = await postMovement(registerId, { idempotencyKey: unique('cmD1') })
    const r2 = await postMovement(registerId, { idempotencyKey: unique('cmD2') })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r2.body?.data?.id).not.toBe(r1.body?.data?.id)
  })
})
