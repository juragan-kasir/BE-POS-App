'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Wave 4 by-id sweep, owner decision 2026-11-05 ("per tenant"): supplier
// categories were one list shared by every tenant — any tenant's admin could
// read, rename and delete another tenant's categories, a category's detail
// listed every tenant's suppliers in it, and a supplier could be filed under
// another tenant's category.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) =>
  `scs_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const ids = {
  tenants: [],
  stores: [],
  users: [],
  categories: [],
  suppliers: []
}
let storeA
let storeB
let tokenA
let tokenGlobal
let catB
let shared

const makeCategory = async (store, name = uniq('CAT')) => {
  const c = await db.supplier_category.create({ name, status: 'active', store })
  ids.categories.push(c.id)
  return c
}
const makeSupplier = async (store, categoryId) => {
  const s = await db.supplier.create({
    name: uniq('SUP'),
    phone: uniq('p'),
    status: 'active',
    store: [store],
    categoryId
  })
  ids.suppliers.push(s.id)
  return s
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
  catB = await makeCategory(storeB.id)
  shared = await makeCategory(null)
})

afterAll(async () => {
  await db.supplier.destroy({ where: { id: ids.suppliers }, force: true })
  await db.supplier.destroy({
    where: { name: { [db.Sequelize.Op.like]: 'scs_%' } },
    force: true
  })
  await db.supplier_category.destroy({
    where: { id: ids.categories },
    force: true
  })
  await db.supplier_category.destroy({
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

describe('supplier categories are per tenant', () => {
  test("the list shows own and shared categories, never another tenant's", async () => {
    const own = await makeCategory(storeA.id)
    const res = await as(tokenA, 'get', '/supplier-category?limit=500')
    expect(res.status).toBe(200)
    const seen = res.body.data.map((c) => c.id)
    expect(seen).toEqual(expect.arrayContaining([own.id, shared.id]))
    expect(seen).not.toContain(catB.id)
  })

  test("another tenant's category is a 404 for detail, edit and delete, and stays unchanged", async () => {
    expect(
      (await as(tokenA, 'get', `/supplier-category/${catB.id}`)).status
    ).toBe(404)
    expect(
      (
        await as(tokenA, 'put', `/supplier-category/${catB.id}`).send({
          name: 'HACKED'
        })
      ).status
    ).toBe(404)
    expect(
      (await as(tokenA, 'delete', `/supplier-category/${catB.id}`)).status
    ).toBe(404)
    const row = await db.supplier_category.findByPk(catB.id)
    expect(row).not.toBeNull()
    expect(row.name).not.toBe('HACKED')
  })

  test('a shared category is readable but read-only for a tenant admin', async () => {
    expect(
      (await as(tokenA, 'get', `/supplier-category/${shared.id}`)).status
    ).toBe(200)
    const edit = await as(
      tokenA,
      'put',
      `/supplier-category/${shared.id}`
    ).send({ name: uniq('HACK') })
    expect(edit.status).toBe(403)
    expect(edit.body.code).toBe('SHARED_CATEGORY_READ_ONLY')
    expect(
      (await as(tokenA, 'delete', `/supplier-category/${shared.id}`)).status
    ).toBe(403)
  })

  test("a shared category's detail lists only the caller's suppliers", async () => {
    const supA = await makeSupplier(storeA.id, shared.id)
    const supB = await makeSupplier(storeB.id, shared.id)
    const res = await as(tokenA, 'get', `/supplier-category/${shared.id}`)
    expect(res.status).toBe(200)
    const seen = res.body.data.suppliers.map((s) => s.id)
    expect(seen).toContain(supA.id)
    expect(seen).not.toContain(supB.id)
  })

  test("a category name used by another tenant does not block this tenant's category", async () => {
    const res = await as(tokenA, 'post', '/supplier-category').send({
      name: catB.name
    })
    expect(res.status).toBe(201)
    const row = await db.supplier_category.findByPk(res.body.data.id)
    ids.categories.push(row.id)
    expect(Number(row.store)).toBe(storeA.id)
    expect(
      (
        await as(tokenA, 'put', `/supplier-category/${row.id}`).send({
          description: 'own'
        })
      ).status
    ).toBe(200)
  })

  test('a global super admin can still change a shared category', async () => {
    const res = await as(
      tokenGlobal,
      'put',
      `/supplier-category/${shared.id}`
    ).send({ description: 'global edit' })
    expect(res.status).toBe(200)
  })

  test("a supplier cannot be filed under another tenant's category", async () => {
    const res = await as(tokenA, 'post', '/supplier').send({
      name: uniq('SUP'),
      phone: `08${Math.floor(1e9 + Math.random() * 8e9)}`,
      categoryId: catB.id
    })
    expect(res.status).toBe(400)
  })
})
