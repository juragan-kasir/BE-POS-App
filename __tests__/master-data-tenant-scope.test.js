'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Wave 4 by-id sweep, owner decision 2026-11-05 ("per tenant"): departments
// and ingredient categories had no outlet column (batch B12 adds one), so
// every tenant read, renamed and deleted the same rows. Deleting a
// department also deactivated every tenant's positions under it, and an
// ingredient category's detail returned every tenant's ingredients to any
// super_admin, store-bound owners included.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const migration = require('../db/migrations/20261106000001-master-data-store-scope')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) =>
  `mds_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const ids = {
  tenants: [],
  stores: [],
  users: [],
  departments: [],
  positions: [],
  categories: [],
  ingredients: []
}
let storeA
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
const dept = async (store, name = uniq('DEPT')) => {
  const d = await db.department.create({ name, status: 'active', store })
  ids.departments.push(d.id)
  return d
}
const cat = async (store, name = uniq('ICAT')) => {
  const c = await db.ingredientCategory.create({
    name,
    status: 'active',
    store
  })
  ids.categories.push(c.id)
  return c
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
  await db.ingredient.destroy({ where: { id: ids.ingredients }, force: true })
  await db.ingredient.destroy({
    where: { name: { [db.Sequelize.Op.like]: 'mds_%' } },
    force: true
  })
  await db.position.destroy({ where: { id: ids.positions }, force: true })
  await db.position.destroy({
    where: { name: { [db.Sequelize.Op.like]: 'mds_%' } },
    force: true
  })
  await db.department.destroy({ where: { id: ids.departments }, force: true })
  await db.department.destroy({
    where: { name: { [db.Sequelize.Op.like]: 'mds_%' } },
    force: true
  })
  await db.ingredientCategory.destroy({
    where: { id: ids.categories },
    force: true
  })
  await db.ingredientCategory.destroy({
    where: { name: { [db.Sequelize.Op.like]: 'mds_%' } },
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

describe('B12 migration', () => {
  test('up is add-if-missing and replays; down refuses while a row belongs to an outlet', async () => {
    await migration.up(db.sequelize.getQueryInterface())
    await migration.up(db.sequelize.getQueryInterface())
    const owned = await dept(storeA.id)
    await expect(
      migration.down(db.sequelize.getQueryInterface())
    ).rejects.toThrow(/belong to an outlet/)
    expect(await db.department.findByPk(owned.id)).not.toBeNull()
  })
})

describe('departments are per tenant', () => {
  test("the list shows own and shared departments, never another tenant's", async () => {
    const own = await dept(storeA.id)
    const shared = await dept(null)
    const foreign = await dept(storeB.id)
    const res = await as(
      tokenAdminA,
      'get',
      '/department/get-department-all?limit=1000'
    )
    expect(res.status).toBe(200)
    const seen = res.body.data.map((d) => d.id)
    expect(seen).toEqual(expect.arrayContaining([own.id, shared.id]))
    expect(seen).not.toContain(foreign.id)
  })

  test("another tenant's department is a 404 for detail, edit and delete, and stays unchanged", async () => {
    const foreign = await dept(storeB.id)
    for (const token of [tokenAdminA, tokenOwnerA]) {
      expect(
        (await as(token, 'get', `/department/get-department/${foreign.id}`))
          .status
      ).toBe(404)
      expect(
        (
          await as(
            token,
            'put',
            `/department/edit-department/${foreign.id}`
          ).send({ id: foreign.id, name: 'HACKED' })
        ).status
      ).toBe(404)
      expect(
        (
          await as(
            token,
            'delete',
            `/department/delete-department/${foreign.id}`
          )
        ).status
      ).toBe(404)
    }
    const row = await db.department.findByPk(foreign.id)
    expect(row).not.toBeNull()
    expect(row.name).not.toBe('HACKED')
  })

  test("deleting a shared department is refused, and other tenants' positions stay active", async () => {
    const shared = await dept(null)
    const posB = await db.position.create({
      name: uniq('POSB'),
      departmentId: shared.id,
      status: 'active',
      store: storeB.id
    })
    ids.positions.push(posB.id)
    const res = await as(
      tokenAdminA,
      'delete',
      `/department/delete-department/${shared.id}`
    )
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('SHARED_DEPARTMENT_READ_ONLY')
    expect((await db.position.findByPk(posB.id)).status).toBe('active')
    expect(await db.department.findByPk(shared.id)).not.toBeNull()
  })

  test("a new department belongs to the creating outlet, and its name may repeat another tenant's", async () => {
    const foreign = await dept(storeB.id)
    const res = await as(
      tokenAdminA,
      'post',
      '/department/add-new-department'
    ).send({ name: foreign.name })
    expect(res.status).toBe(200)
    const row = await db.department.findByPk(res.body.data.id)
    ids.departments.push(row.id)
    expect(Number(row.store)).toBe(storeA.id)
    expect(
      (
        await as(
          tokenAdminA,
          'put',
          `/department/edit-department/${row.id}`
        ).send({ id: row.id, name: uniq('REN') })
      ).status
    ).toBe(200)
  })

  test('a global super admin can still change a shared department', async () => {
    const shared = await dept(null)
    const res = await as(
      tokenGlobal,
      'put',
      `/department/edit-department/${shared.id}`
    ).send({ id: shared.id, name: uniq('GLOBAL') })
    expect(res.status).toBe(200)
  })

  test("a position cannot be filed under another tenant's department", async () => {
    const foreign = await dept(storeB.id)
    const res = await as(
      tokenAdminA,
      'post',
      '/position/add-new-position'
    ).send({ name: uniq('POS'), departmentId: foreign.id })
    expect(res.status).toBe(400)
  })
})

describe('ingredient categories are per tenant', () => {
  test("the list shows own and shared categories, never another tenant's", async () => {
    const own = await cat(storeA.id)
    const shared = await cat(null)
    const foreign = await cat(storeB.id)
    const res = await as(
      tokenAdminA,
      'get',
      '/ingredient-category/get-all?limit=1000'
    )
    expect(res.status).toBe(200)
    const seen = res.body.data.map((c) => c.id)
    expect(seen).toEqual(expect.arrayContaining([own.id, shared.id]))
    expect(seen).not.toContain(foreign.id)
  })

  test("another tenant's category is a 404 for detail, edit and delete, and stays unchanged", async () => {
    const foreign = await cat(storeB.id)
    for (const token of [tokenAdminA, tokenOwnerA]) {
      expect(
        (await as(token, 'get', `/ingredient-category/get-by-id/${foreign.id}`))
          .status
      ).toBe(404)
      expect(
        (
          await as(
            token,
            'put',
            `/ingredient-category/edit/${foreign.id}`
          ).send({ name: 'HACKED' })
        ).status
      ).toBe(404)
      expect(
        (await as(token, 'delete', `/ingredient-category/delete/${foreign.id}`))
          .status
      ).toBe(404)
    }
    expect((await db.ingredientCategory.findByPk(foreign.id)).name).not.toBe(
      'HACKED'
    )
  })

  test('a shared category is read-only for a tenant, and its detail lists only own and shared ingredients', async () => {
    const shared = await cat(null)
    const ingA = await db.ingredient.create({
      name: uniq('INGA'),
      category: shared.id,
      store: storeA.id,
      unit: 'pcs'
    })
    const ingB = await db.ingredient.create({
      name: uniq('INGB'),
      category: shared.id,
      store: storeB.id,
      unit: 'pcs'
    })
    ids.ingredients.push(ingA.id, ingB.id)

    const edit = await as(
      tokenAdminA,
      'put',
      `/ingredient-category/edit/${shared.id}`
    ).send({ name: uniq('HACK') })
    expect(edit.status).toBe(403)
    expect(edit.body.code).toBe('SHARED_CATEGORY_READ_ONLY')

    // The store-bound owner used to see every tenant's ingredients here.
    const res = await as(
      tokenOwnerA,
      'get',
      `/ingredient-category/get-by-id/${shared.id}`
    )
    expect(res.status).toBe(200)
    const seen = res.body.data.ingredients.map((i) => i.id)
    expect(seen).toContain(ingA.id)
    expect(seen).not.toContain(ingB.id)
  })

  test('a new category belongs to the creating outlet', async () => {
    const res = await as(tokenAdminA, 'post', '/ingredient-category/add').send({
      name: uniq('NEW')
    })
    expect(res.status).toBe(201)
    const row = await db.ingredientCategory.findByPk(res.body.data.id)
    ids.categories.push(row.id)
    expect(Number(row.store)).toBe(storeA.id)
  })

  test("an ingredient cannot be filed under another tenant's category", async () => {
    const foreign = await cat(storeB.id)
    const res = await as(tokenAdminA, 'post', '/ingredient/add').send({
      name: uniq('ING'),
      category: foreign.id,
      unit: 'pcs'
    })
    expect(res.status).toBe(400)
  })
})
