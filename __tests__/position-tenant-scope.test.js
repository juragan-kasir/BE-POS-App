'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Wave 4 (owner decision 2026-11-05: shared master data is per tenant).
// Position by-id routes were store-scoped, but the lists, stats and Excel
// export covered every tenant, a name used by any tenant blocked yours, and
// an Excel import created positions with no outlet — visible to everyone.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) =>
  `pts_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const ids = { tenants: [], stores: [], users: [], positions: [] }
let storeA
let storeA2
let storeB
let tokenAdminA
let tokenOwnerA
let tokenGlobal

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
const pos = async (store, name = uniq('POS')) => {
  const p = await db.position.create({ name, status: 'active', store })
  ids.positions.push(p.id)
  return p
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
  storeA2 = await db.location.create({
    name: uniq('SA2'),
    status: 'active',
    tenantId: tA.id
  })
  storeB = await db.location.create({
    name: uniq('SB'),
    status: 'active',
    tenantId: tB.id
  })
  ids.stores.push(storeA.id, storeA2.id, storeB.id)

  const adminA = await makeUser('admin', storeA.id)
  tokenAdminA = await signSessionToken(
    {
      id: adminA.id,
      userName: adminA.userName,
      roleType: 'admin',
      store: storeA.id
    },
    JWT_SECRET
  )
  const ownerA = await makeUser('super_admin', storeA.id)
  await db.tenantMembership.create({
    userId: ownerA.id,
    tenantId: tA.id,
    role: 'tenant_admin',
    status: 'ACTIVE'
  })
  tokenOwnerA = await signSessionToken(
    {
      id: ownerA.id,
      userName: ownerA.userName,
      roleType: 'super_admin',
      store: storeA.id
    },
    JWT_SECRET
  )
  const globalSa = await makeUser('super_admin', null)
  tokenGlobal = await signSessionToken(
    { id: globalSa.id, userName: globalSa.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.position.destroy({ where: { id: ids.positions }, force: true })
  await db.position.destroy({
    where: { name: { [db.Sequelize.Op.like]: 'pts_%' } },
    force: true
  })
  await db.tenantMembership.destroy({
    where: { userId: ids.users },
    force: true
  })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

const as = (token, method, path) =>
  request(app)[method](path).set('Authorization', `Bearer ${token}`)

describe('positions are per tenant', () => {
  test("the lists show own and shared positions, never another tenant's", async () => {
    const own = await pos(storeA.id)
    const shared = await pos(null)
    const foreign = await pos(storeB.id)
    for (const token of [tokenAdminA, tokenOwnerA]) {
      const table = await as(
        token,
        'get',
        '/position/get-position-all?limit=1000'
      )
      expect(table.status).toBe(200)
      const seen = table.body.data.map((p) => p.id)
      expect(seen).toEqual(expect.arrayContaining([own.id, shared.id]))
      expect(seen).not.toContain(foreign.id)
      const active = await as(token, 'get', '/position/get-position')
      expect(active.body.data.map((p) => p.id)).not.toContain(foreign.id)
    }
  })

  test("another tenant's position is a 404 for detail, edit and delete, and stays unchanged", async () => {
    const foreign = await pos(storeB.id)
    for (const token of [tokenAdminA, tokenOwnerA]) {
      expect(
        (await as(token, 'get', `/position/get-position/${foreign.id}`)).status
      ).toBe(404)
      expect(
        (
          await as(token, 'put', `/position/edit-position/${foreign.id}`).send({
            id: foreign.id,
            name: 'HACKED'
          })
        ).status
      ).toBe(404)
      expect(
        (await as(token, 'delete', `/position/delete-position/${foreign.id}`))
          .status
      ).toBe(404)
    }
    const row = await db.position.findByPk(foreign.id)
    expect(row).not.toBeNull()
    expect(row.name).not.toBe('HACKED')
  })

  test('a shared position is readable but read-only for a tenant', async () => {
    const shared = await pos(null)
    expect(
      (await as(tokenAdminA, 'get', `/position/get-position/${shared.id}`))
        .status
    ).toBe(200)
    const edit = await as(
      tokenAdminA,
      'put',
      `/position/edit-position/${shared.id}`
    ).send({ id: shared.id, name: uniq('HACK') })
    expect(edit.status).toBe(403)
    expect(edit.body.code).toBe('SHARED_POSITION_READ_ONLY')
    expect(
      (
        await as(
          tokenAdminA,
          'delete',
          `/position/delete-position/${shared.id}`
        )
      ).status
    ).toBe(403)
    expect(await db.position.findByPk(shared.id)).not.toBeNull()
  })

  test("a new position belongs to the caller's outlet, and another tenant's name does not block it", async () => {
    const foreign = await pos(storeB.id)
    const res = await as(
      tokenAdminA,
      'post',
      '/position/add-new-position'
    ).send({ name: foreign.name })
    expect(res.status).toBe(200)
    const row = await db.position.findByPk(res.body.data.id)
    ids.positions.push(row.id)
    expect(Number(row.store)).toBe(storeA.id)
  })

  test("the owner can move a position between its own outlets, never into another tenant's", async () => {
    const own = await pos(storeA.id)
    const moved = await as(
      tokenOwnerA,
      'put',
      `/position/edit-position/${own.id}`
    ).send({ id: own.id, name: own.name, store: storeA2.id })
    expect(moved.status).toBe(200)
    expect(Number((await db.position.findByPk(own.id)).store)).toBe(storeA2.id)

    const out = await as(
      tokenOwnerA,
      'put',
      `/position/edit-position/${own.id}`
    ).send({ id: own.id, name: own.name, store: storeB.id })
    expect(out.status).toBe(403)
    expect(Number((await db.position.findByPk(own.id)).store)).toBe(storeA2.id)
  })

  test('a global super admin can still change a shared position', async () => {
    const shared = await pos(null)
    const res = await as(
      tokenGlobal,
      'put',
      `/position/edit-position/${shared.id}`
    ).send({ id: shared.id, name: uniq('GLOBAL') })
    expect(res.status).toBe(200)
  })
})
