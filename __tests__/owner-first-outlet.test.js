'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Owner onboarding without an outlet (2026-11-16): a client owner starts as a
// store-less `admin` with a tenant_admin membership. They see no outlet, may
// create the first outlet of their own tenant only, and that outlet binds the
// account (store-bound super_admin = the standard client owner).
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const P = 'ofo'
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const created = { users: [], tenants: [], stores: [] }

const mkUser = async (attrs) => {
  const user = await db.user.create({
    userName: `${P}_${uniq()}`,
    email: `${P}_${uniq()}@test.com`,
    status: 'active',
    ...attrs
  })
  created.users.push(user.id)
  return user
}
const tokenFor = (user) =>
  signSessionToken({ id: user.id, userName: user.userName, roleType: user.roleType, store: user.store ?? undefined }, JWT_SECRET)
const outletBody = (name, extra = {}) => ({ name, status: 'active', timezone: 'Asia/Jakarta', businessType: 'laundry', ...extra })

let home
let other
let foreignStore

beforeAll(async () => {
  home = await db.tenant.create({ code: `${P}-home-${uniq()}`, name: 'OFO Home', status: 'active' })
  other = await db.tenant.create({ code: `${P}-other-${uniq()}`, name: 'OFO Other', status: 'active' })
  created.tenants.push(home.id, other.id)
  foreignStore = await db.location.create({ name: `OFO_F_${uniq()}`, status: 'active', tenantId: other.id })
  created.stores.push(foreignStore.id)
})

afterAll(async () => {
  const ids = created.stores
  const own = await db.location.findAll({ where: { tenantId: created.tenants }, attributes: ['id'], paranoid: false })
  const storeIds = [...new Set([...ids, ...own.map((l) => l.id)])]
  await db.tenantMembership.destroy({ where: { userId: created.users }, force: true })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.location.destroy({ where: { id: storeIds }, force: true })
  await db.tenant.destroy({ where: { id: created.tenants }, force: true })
  await db.sequelize.close()
})

describe('store-less tenant_admin owner', () => {
  let owner
  let token

  beforeAll(async () => {
    owner = await mkUser({ roleType: 'admin', userType: 'admin', store: null })
    await db.tenantMembership.create({ userId: owner.id, tenantId: home.id, role: 'tenant_admin', status: 'ACTIVE' })
    token = await tokenFor(owner)
  })

  it('is not a platform admin and sees no outlet before the first one', async () => {
    const ctx = await request(app).get('/auth/context').set('Authorization', `Bearer ${token}`)
    expect(ctx.status).toBe(200)
    const c = ctx.body.data.context
    expect(c.activeRole).toBe('tenant_admin')
    expect(Number(c.activeTenantId)).toBe(home.id)
    expect(c.isPlatformAdmin).not.toBe(true)

    const mine = await request(app).get('/location/get-location-mine').set('Authorization', `Bearer ${token}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data).toEqual([])
  })

  it('cannot create an outlet in a foreign tenant', async () => {
    const res = await request(app)
      .post('/location/add-new-location')
      .set('Authorization', `Bearer ${token}`)
      .send(outletBody(`OFO_X_${uniq()}`, { tenantId: other.id }))
    expect(res.status).toBe(422)
    const row = await db.user.findByPk(owner.id)
    expect(row.store).toBeNull()
    expect(row.roleType).toBe('admin')
  })

  it('creates the first outlet in its own tenant and is bound to it', async () => {
    const res = await request(app)
      .post('/location/add-new-location')
      .set('Authorization', `Bearer ${token}`)
      .send(outletBody(`OFO_A_${uniq()}`))
    expect(res.status).toBe(201)
    expect(res.body.data.ownerBound).toBe(true)
    const outletId = Number(res.body.data.id)
    created.stores.push(outletId)

    const loc = await db.location.findByPk(outletId)
    expect(loc.tenantId).toBe(home.id)
    expect(loc.businessType).toBe('laundry')

    const row = await db.user.findByPk(owner.id)
    expect(row.store).toBe(outletId)
    expect(row.roleType).toBe('super_admin')

    // Same session keeps working, now as the standard store-bound owner.
    const mine = await request(app).get('/location/get-location-mine').set('Authorization', `Bearer ${token}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data.map((l) => Number(l.id))).toEqual([outletId])
    const ctx = await request(app).get('/auth/context').set('Authorization', `Bearer ${token}`)
    expect(ctx.body.data.context.isPlatformAdmin).not.toBe(true)
    expect(Number(ctx.body.data.context.activeTenantId)).toBe(home.id)
  })
})

describe('accounts that are not a store-less tenant_admin', () => {
  it('a store-less admin without membership is refused', async () => {
    const admin = await mkUser({ roleType: 'admin', userType: 'admin', store: null })
    const res = await request(app)
      .post('/location/add-new-location')
      .set('Authorization', `Bearer ${await tokenFor(admin)}`)
      .send(outletBody(`OFO_N_${uniq()}`))
    expect(res.status).toBe(403)
    expect(await db.location.count({ where: { tenantId: home.id, name: { [db.Sequelize.Op.like]: 'OFO_N_%' } } })).toBe(0)
  })

  it('a store-bound admin still cannot create outlets (super_admin only)', async () => {
    const admin = await mkUser({ roleType: 'admin', userType: 'admin', store: foreignStore.id })
    const res = await request(app)
      .post('/location/add-new-location')
      .set('Authorization', `Bearer ${await tokenFor(admin)}`)
      .send(outletBody(`OFO_B_${uniq()}`))
    expect(res.status).toBe(403)
  })

  it('a store-less kasir is refused', async () => {
    const kasir = await mkUser({ roleType: 'kasir', userType: 'kasir', store: null })
    const res = await request(app)
      .post('/location/add-new-location')
      .set('Authorization', `Bearer ${await tokenFor(kasir)}`)
      .send(outletBody(`OFO_K_${uniq()}`))
    expect(res.status).toBe(403)
  })
})
