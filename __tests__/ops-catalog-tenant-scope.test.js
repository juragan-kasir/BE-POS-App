'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Wave 4 by-id sweep, last group: queue, product bundle, delivery driver,
// type payment, notification, reservation and overtime let a store-bound
// owner (super_admin with a tenant) reach another tenant's rows. By-id
// routes are covered by tenant-by-id-sweep.test.js (now zero known leaks);
// this file pins the new array-shape helper and the reservation list.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { tenantArrayStoreWhere } = require('../utils/tenantScope')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) =>
  `ocs_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const ids = { tenants: [], stores: [], users: [], reservations: [], queues: [] }
let storeA
let storeB
let owner
let tokenOwnerA

beforeAll(async () => {
  const tA = await db.tenant.create({
    code: uniq('A').toUpperCase(),
    name: uniq('TA')
  })
  const tB = await db.tenant.create({
    code: uniq('B').toUpperCase(),
    name: uniq('TB')
  })
  ids.tenants.push(tA.id, tB.id)
  storeA = await db.location.create({
    name: uniq('SA'),
    status: 'active',
    tenantId: tA.id
  })
  storeB = await db.location.create({
    name: uniq('SB'),
    status: 'active',
    tenantId: tB.id
  })
  ids.stores.push(storeA.id, storeB.id)
  owner = await db.user.create({
    userName: uniq('owner'),
    email: `${uniq('owner')}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active',
    store: storeA.id
  })
  ids.users.push(owner.id)
  await db.tenantMembership.create({
    userId: owner.id,
    tenantId: tA.id,
    role: 'tenant_admin',
    status: 'ACTIVE'
  })
  tokenOwnerA = await signSessionToken(
    {
      id: owner.id,
      userName: owner.userName,
      roleType: 'super_admin',
      store: storeA.id
    },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.reservation.destroy({ where: { id: ids.reservations }, force: true })
  await db.queue.destroy({ where: { id: ids.queues }, force: true })
  await db.tenantMembership.destroy({
    where: { userId: ids.users },
    force: true
  })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

describe('tenantArrayStoreWhere', () => {
  const queueIn = async (store) => {
    const q = await db.queue.create({
      queueNumber: uniq('Q'),
      customerName: uniq('C'),
      store
    })
    ids.queues.push(q.id)
    return q
  }

  test("confines a store-bound owner to its tenant's rows, for scalar and array store values", async () => {
    const scalarA = await queueIn(storeA.id)
    const arrayA = await queueIn([storeA.id])
    const foreign = await queueIn(storeB.id)
    const req = {
      user: { id: owner.id, roleType: 'super_admin', store: storeA.id }
    }
    const where = await tenantArrayStoreWhere(req, {
      id: [scalarA.id, arrayA.id, foreign.id]
    })
    const seen = (await db.queue.findAll({ where })).map((q) => q.id)
    expect(seen.sort()).toEqual([scalarA.id, arrayA.id].sort())
  })

  test('leaves a global super admin unrestricted', async () => {
    const where = await tenantArrayStoreWhere(
      { user: { id: 1, roleType: 'super_admin', store: null } },
      { id: 5 }
    )
    expect(where).toEqual({ id: 5 })
  })

  test('shared (store null) rows are included only when asked (driver shape)', async () => {
    const shared = await queueIn(null)
    const req = {
      user: { id: owner.id, roleType: 'super_admin', store: storeA.id }
    }
    const plain = await db.queue.findAll({
      where: await tenantArrayStoreWhere(req, { id: shared.id })
    })
    const withShared = await db.queue.findAll({
      where: await tenantArrayStoreWhere(
        req,
        { id: shared.id },
        { includeShared: true }
      )
    })
    expect(plain).toHaveLength(0)
    expect(withShared.map((q) => q.id)).toEqual([shared.id])
  })
})

describe('reservation list', () => {
  test("without ?store the owner sees its tenant's reservations, never another tenant's", async () => {
    const make = async (store) => {
      const r = await db.reservation.create({
        customerName: uniq('R'),
        reservationDate: '2026-11-06',
        startTime: '18:00:00',
        store
      })
      ids.reservations.push(r.id)
      return r
    }
    const own = await make(storeA.id)
    const foreign = await make(storeB.id)
    const res = await request(app)
      .get('/reservation?size=1000')
      .set('Authorization', `Bearer ${tokenOwnerA}`)
    expect(res.status).toBe(200)
    const text = JSON.stringify(res.body)
    expect(text).toContain(own.customerName)
    expect(text).not.toContain(foreign.customerName)
  })
})
