'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Wave 4 by-id sweep, owner decision 2026-11-05 ("per tenant"): member tiers
// were one ladder shared by every tenant. Any tenant's admin could read,
// edit and delete another tenant's tiers, and a tier one tenant created
// graded (and discounted) another tenant's members.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { maybeUpgradeMemberTier } = require('../api/service/loyaltyService')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) =>
  `mts_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const ids = { tenants: [], stores: [], users: [], tiers: [], members: [] }
let storeA
let storeB
let tokenA
let tokenGlobal
let tierB
let sharedTier

const makeTier = async (store, extra = {}) => {
  const t = await db.member_tier.create({
    name: uniq('TIER'),
    minPoints: 0,
    maxPoints: 1000000,
    discountPercent: 5,
    status: 'active',
    store,
    ...extra
  })
  ids.tiers.push(t.id)
  return t
}
const makeUser = async (roleType, store) => {
  const u = await db.user.create({
    userName: uniq(roleType),
    email: `${uniq(roleType)}@test.com`,
    roleType,
    userType: 'admin',
    status: 'active',
    store
  })
  ids.users.push(u.id)
  return u
}

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

  const adminA = await makeUser('admin', storeA.id)
  tokenA = await signSessionToken(
    {
      id: adminA.id,
      userName: adminA.userName,
      roleType: 'admin',
      store: storeA.id
    },
    JWT_SECRET
  )
  const globalSa = await makeUser('super_admin', null)
  tokenGlobal = await signSessionToken(
    { id: globalSa.id, userName: globalSa.userName, roleType: 'super_admin' },
    JWT_SECRET
  )

  tierB = await makeTier(storeB.id, { name: uniq('B_GOLD') })
  sharedTier = await makeTier(null, { name: uniq('SHARED') })
})

afterAll(async () => {
  await db.member.destroy({ where: { id: ids.members }, force: true })
  await db.member_tier.destroy({ where: { id: ids.tiers }, force: true })
  await db.member_tier.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

const as = (token, method, path) =>
  request(app)[method](path).set('Authorization', `Bearer ${token}`)

describe('member tiers are per tenant', () => {
  test("the list shows the caller's tiers and the shared defaults, never another tenant's", async () => {
    const own = await makeTier(storeA.id)
    const res = await as(tokenA, 'get', '/member-tier/get-all')
    expect(res.status).toBe(200)
    const seen = res.body.data.map((t) => t.id)
    expect(seen).toEqual(expect.arrayContaining([own.id, sharedTier.id]))
    expect(seen).not.toContain(tierB.id)
  })

  test("another tenant's tier is a 404 for detail, edit and delete, and stays unchanged", async () => {
    expect(
      (await as(tokenA, 'get', `/member-tier/detail/${tierB.id}`)).status
    ).toBe(404)
    expect(
      (
        await as(tokenA, 'put', `/member-tier/edit/${tierB.id}`).send({
          discountPercent: 90
        })
      ).status
    ).toBe(404)
    expect(
      (await as(tokenA, 'delete', `/member-tier/delete/${tierB.id}`)).status
    ).toBe(404)
    const row = await db.member_tier.findByPk(tierB.id)
    expect(row).not.toBeNull()
    expect(Number(row.discountPercent)).toBe(5)
  })

  test('a shared default tier is readable but read-only for a tenant admin', async () => {
    expect(
      (await as(tokenA, 'get', `/member-tier/detail/${sharedTier.id}`)).status
    ).toBe(200)
    const edit = await as(
      tokenA,
      'put',
      `/member-tier/edit/${sharedTier.id}`
    ).send({ discountPercent: 50 })
    expect(edit.status).toBe(403)
    expect(edit.body.code).toBe('SHARED_TIER_READ_ONLY')
    expect(
      (await as(tokenA, 'delete', `/member-tier/delete/${sharedTier.id}`))
        .status
    ).toBe(403)
    expect(
      Number((await db.member_tier.findByPk(sharedTier.id)).discountPercent)
    ).toBe(5)
  })

  test('a tier a tenant admin creates belongs to its outlet, and it can edit it', async () => {
    const res = await as(tokenA, 'post', '/member-tier/add').send({
      name: uniq('A_NEW'),
      minPoints: 0,
      maxPoints: 100
    })
    expect(res.status).toBe(201)
    const row = await db.member_tier.findByPk(res.body.data.id)
    ids.tiers.push(row.id)
    expect(Number(row.store)).toBe(storeA.id)
    expect(
      (
        await as(tokenA, 'put', `/member-tier/edit/${row.id}`).send({
          discountPercent: 7
        })
      ).status
    ).toBe(200)
  })

  test('a global super admin can still change a shared default tier', async () => {
    const res = await as(
      tokenGlobal,
      'put',
      `/member-tier/edit/${sharedTier.id}`
    ).send({ discountPercent: 6 })
    expect(res.status).toBe(200)
    expect(
      Number((await db.member_tier.findByPk(sharedTier.id)).discountPercent)
    ).toBe(6)
    await sharedTier.reload()
  })
})

describe("a member is graded on its own outlet's ladder", () => {
  const makeMember = async (store, totalPoints) => {
    const m = await db.member.create({
      name: uniq('M'),
      phoneNumber: `08${Math.floor(1e9 + Math.random() * 8e9)}`,
      store,
      totalPoints,
      status: 'active'
    })
    ids.members.push(m.id)
    return m
  }

  test("a tier tenant A creates never grades tenant B's member", async () => {
    // Tenant A creates a rich tier that covers every point total.
    const rich = await makeTier(storeA.id, {
      name: uniq('A_RICH'),
      minPoints: 1,
      maxPoints: 9999999,
      discountPercent: 80
    })
    const memberB = await makeMember(storeB.id, 500)
    await db.sequelize.transaction((transaction) =>
      maybeUpgradeMemberTier({ member: memberB, transaction })
    )
    await memberB.reload()
    expect(memberB.tier).not.toBe(rich.id)
    expect(memberB.tier).toBe(tierB.id)
  })

  test('an outlet without tiers of its own falls back to the shared defaults', async () => {
    const tC = await db.tenant.create({
      code: uniq('C').toUpperCase(),
      name: uniq('TC')
    })
    ids.tenants.push(tC.id)
    const storeC = await db.location.create({
      name: uniq('SC'),
      status: 'active',
      tenantId: tC.id
    })
    ids.stores.push(storeC.id)
    const memberC = await makeMember(storeC.id, 10)
    await db.sequelize.transaction((transaction) =>
      maybeUpgradeMemberTier({ member: memberC, transaction })
    )
    await memberC.reload()
    const tier = await db.member_tier.findByPk(memberC.tier)
    expect(tier.store).toBeNull()
  })

  test("re-grading members from tenant A never touches tenant B's members", async () => {
    const memberB = await makeMember(storeB.id, 500)
    await memberB.update({ tier: null })
    const res = await as(tokenA, 'post', '/member-tier/update-members')
    expect(res.status).toBe(200)
    await memberB.reload()
    expect(memberB.tier).toBeNull()
  })
})
