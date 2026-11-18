'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// BE audit 2026-11-18 (H4): the laundry owner-PIN hash must never leave the
// API. A short numeric PIN behind bcrypt is brute-forceable offline, and the
// PIN approves refunds/cancellations — an admin who saw the hash could act as
// the owner. Covered: model serialization (toJSON / nested get), the
// edit-location response (spread dataValues), and PIN preservation on update.
const request = require('supertest')
const bcrypt = require('bcrypt')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
const created = { users: [], stores: [], tenants: [] }
let tenant
let store
let saAuth
let hash

beforeAll(async () => {
  tenant = await db.tenant.create({ code: `pinx-${RUN}`, name: `PINX ${RUN}`, status: 'active' })
  created.tenants.push(tenant.id)
  hash = await bcrypt.hash('123456', 4)
  store = await db.location.create({
    name: `PINX_STORE_${RUN}`,
    status: 'active',
    businessType: 'laundry',
    tenantId: tenant.id,
    laundrySettings: { serviceModel: 'hybrid', minDpPercent: 20, storageDays: 30, ownerPinHash: hash }
  })
  created.stores.push(store.id)
  const sa = await db.user.create({
    userName: `pinx_sa_${RUN}`,
    email: `pinx_sa_${RUN}@t.test`,
    roleType: 'super_admin',
    userType: 'super_admin',
    status: 'active'
  })
  created.users.push(sa.id)
  saAuth = {
    Authorization: `Bearer ${await signSessionToken({ id: sa.id, userName: sa.userName, roleType: 'super_admin' }, JWT_SECRET)}`
  }
})

afterAll(async () => {
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
  await db.tenant.destroy({ where: { id: created.tenants }, force: true })
  await db.sequelize.close()
})

const hasHash = (value) => JSON.stringify(value).includes('ownerPinHash') || JSON.stringify(value).includes(hash)

test('model serialization exposes hasOwnerPin, never the hash', async () => {
  const row = await db.location.findByPk(store.id)
  expect(hasHash(row.toJSON())).toBe(false)
  expect(hasHash(row.get({ plain: true }))).toBe(false)
  expect(row.laundrySettings.hasOwnerPin).toBe(true)
  // Server-side code that must verify the PIN still reads the stored hash.
  expect(row.getDataValue('laundrySettings').ownerPinHash).toBe(hash)
})

test('a stored hasOwnerPin flag is never trusted', () => {
  const row = db.location.build({ laundrySettings: { serviceModel: 'hybrid', hasOwnerPin: true } })
  expect(row.laundrySettings.hasOwnerPin).toBe(false)
})

test('edit-location response carries no hash and the PIN survives the update', async () => {
  const res = await request(app)
    .put('/location/edit-location')
    .set(saAuth)
    .send({ data: { id: store.id, name: `PINX_RENAMED_${RUN}`, laundrySettings: { serviceModel: 'hybrid', minDpPercent: 30, storageDays: 30 } } })

  expect(res.status).toBe(200)
  expect(hasHash(res.body)).toBe(false)
  expect(res.body.data.laundrySettings.hasOwnerPin).toBe(true)

  const fresh = await db.location.findByPk(store.id)
  expect(fresh.getDataValue('laundrySettings').ownerPinHash).toBe(hash)
  expect(fresh.laundrySettings.minDpPercent).toBe(30)
})
