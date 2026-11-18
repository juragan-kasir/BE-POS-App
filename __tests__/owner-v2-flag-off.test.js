'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'
delete process.env.AUTHZ_OWNER_V2

// AUTHZ_OWNER_V2 OFF (the production default until the backfill): the owner
// hierarchy is inert — no onboarding endpoint, no onboarding prompt, the new
// vocabulary and the platform_admin table authorize nothing. Every legacy
// suite runs in this mode unchanged.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { resolveAuthorizationContext } = require('../utils/authContext')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const created = { users: [], tenants: [] }
let tenant
let owner
let fresh
let vendor

const mkUser = async (attrs = {}) => {
  const u = await db.user.create({ userName: `ov2off_${uniq()}`, email: `ov2off_${uniq()}@test.com`, status: 'active', roleType: 'user', ...attrs })
  created.users.push(u.id)
  return u
}
const tokenFor = (user) => signSessionToken({ id: user.id, userName: user.userName, roleType: user.roleType }, JWT_SECRET)

beforeAll(async () => {
  tenant = await db.tenant.create({ code: `ov2off-${uniq()}`, name: 'OV2 OFF', status: 'active' })
  created.tenants.push(tenant.id)
  owner = await mkUser()
  await db.tenantMembership.create({ userId: owner.id, tenantId: tenant.id, role: 'owner', status: 'ACTIVE' })
  fresh = await mkUser()
  vendor = await mkUser()
  await db.platformAdmin.create({ userId: vendor.id, status: 'ACTIVE' })
})

afterAll(async () => {
  await db.platformAdmin.destroy({ where: { userId: created.users }, force: true })
  await db.tenantMembership.destroy({ where: { userId: created.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.tenant.destroy({ where: { id: created.tenants }, force: true })
  await db.sequelize.close()
})

test('POST /onboarding/tenants does not exist', async () => {
  const res = await request(app)
    .post('/onboarding/tenants')
    .set('Authorization', `Bearer ${await tokenFor(fresh)}`)
    .send({ code: `ov2off-${uniq()}`, name: 'X' })
  expect(res.status).toBe(404)
})

test('/auth/context never asks to onboard', async () => {
  const res = await request(app).get('/auth/context').set('Authorization', `Bearer ${await tokenFor(fresh)}`)
  expect(res.status).toBe(200)
  expect(res.body.data.context.onboardingRequired).toBe(false)
})

test('an owner membership and a platform_admin grant authorize nothing', async () => {
  const ownerCtx = await resolveAuthorizationContext(db, { userId: owner.id })
  expect(ownerCtx.effectiveTenantIds).toEqual([])
  expect(ownerCtx.permissions).toEqual([])
  const vendorCtx = await resolveAuthorizationContext(db, { userId: vendor.id })
  expect(vendorCtx.isPlatformAdmin).toBe(false)
  expect(vendorCtx.permissions).toEqual([])
})

test('outlet creation keeps the legacy gate', async () => {
  const res = await request(app)
    .post('/location/add-new-location')
    .set('Authorization', `Bearer ${await tokenFor(owner)}`)
    .send({ name: `OV2OFF_${uniq()}`, status: 'active' })
  expect(res.status).toBe(403)
})
