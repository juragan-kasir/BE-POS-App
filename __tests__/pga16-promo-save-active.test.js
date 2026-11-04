'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-16 (product-grade audit 2026-11-02): a campaign saved with "Simpan"
// (status 'active') was stored as 'draft' because createPromoCampaignSchema
// had no status key and zod stripped it.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const DAY = 86400000
const uniq = (k) => `pga16_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const ids = { tenants: [], stores: [], users: [], campaigns: [] }
let token

beforeAll(async () => {
  const tenant = await db.tenant.create({ code: uniq('T').toUpperCase(), name: uniq('Tenant') })
  ids.tenants.push(tenant.id)
  const store = await db.location.create({ name: uniq('S'), status: 'active', tenantId: tenant.id })
  ids.stores.push(store.id)
  const owner = await db.user.create({
    userName: uniq('owner'),
    email: `${uniq('owner')}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active',
    store: store.id
  })
  ids.users.push(owner.id)
  await db.tenantMembership.create({ userId: owner.id, tenantId: tenant.id, role: 'tenant_admin', status: 'ACTIVE' })
  token = await signSessionToken({ id: owner.id, roleType: 'super_admin', store: store.id }, JWT_SECRET)
})

afterAll(async () => {
  const where = { createdBy: ids.users }
  const rows = await db.promo_campaign.findAll({ where, paranoid: false, attributes: ['id'] })
  const cids = rows.map((r) => r.id)
  if (cids.length) {
    await db.promo_reward.destroy({ where: { campaignId: cids }, force: true }).catch(() => {})
    await db.promo_campaign.destroy({ where: { id: cids }, force: true })
  }
  await db.tenantMembership.destroy({ where: { userId: ids.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

const create = (body) =>
  request(app)
    .post('/promo/campaigns')
    .set({ Authorization: `Bearer ${token}` })
    .send({
      store: null,
      name: uniq('PROMO'),
      type: 'manual',
      startDate: new Date(Date.now() - DAY).toISOString(),
      endDate: new Date(Date.now() + DAY).toISOString(),
      rewards: [{ rewardType: 'discount_fixed', rewardValue: 1000 }],
      ...body
    })

describe('PGA-16: the status the owner saves is the status stored', () => {
  test.each([
    ['Simpan (active)', 'active', 'active'],
    ['Simpan Draft (draft)', 'draft', 'draft'],
    ['no status (legacy client)', undefined, 'draft']
  ])('%s', async (_label, status, stored) => {
    const res = await create(status === undefined ? {} : { status })
    expect(res.status).toBe(201)
    const row = await db.promo_campaign.findByPk(res.body.data.id)
    expect(row.status).toBe(stored)
  })

  test('a lifecycle status that create does not allow is refused', async () => {
    const res = await create({ status: 'expired' })
    expect(res.status).toBe(400)
  })
})
