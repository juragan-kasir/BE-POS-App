'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W3-y (owner decision 2026-11-19, BE audit README): shared rows (store NULL,
// tenantId NULL) of type_payment, tax_config and role are PLATFORM data.
// Every tenant reads them; only a global super_admin (no store pin) creates,
// changes or deletes them. Before this, a store-bound super_admin (e.g. a
// tenant's own admin account) could
//   - create a shared payment type with store "all" (seen by every tenant),
//   - move its own payment type to the shared scope with an edit, and
//   - delete a shared payment type (gone for every tenant).
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) => `plat_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const f = {}

const makeUser = async (roleType, store) => {
  const user = await db.user.create({
    userName: uniq(roleType), email: `${uniq('m')}@test.com`, roleType, userType: 'user',
    store, status: 'active', fullName: `plat ${roleType}`
  })
  const token = await signSessionToken({ id: user.id, userName: user.userName, roleType, store }, JWT_SECRET)
  return { user, token }
}
const as = (who, method, url) => request(app)[method](url).set('Authorization', `Bearer ${who.token}`)

beforeAll(async () => {
  f.a = await db.location.create(await withTestTenant({ name: uniq('A'), status: 'active', timezone: 'Asia/Jakarta' }))
  f.boundSA = await makeUser('super_admin', f.a.id)
  f.admin = await makeUser('admin', f.a.id)
  f.globalSA = await makeUser('super_admin', null)
})

beforeEach(async () => {
  f.tp = await db.type_payment.create({ name: uniq('PTP'), store: null, type: 'cash', status: 'active' })
  f.tax = await db.taxConfig.create({ name: uniq('PTX'), store: null, rate: 11, type: 'ppn', status: 'active' })
  f.role = await db.role.create({ name: uniq('PRL'), store: null, roleType: 'kasir', status: 'active' })
})

afterEach(async () => {
  await db.type_payment.destroy({ where: { name: { [db.Sequelize.Op.like]: 'plat_%' } }, force: true })
  await db.taxConfig.destroy({ where: { id: f.tax.id }, force: true })
  await db.role.destroy({ where: { id: f.role.id }, force: true })
})

afterAll(async () => {
  for (const k of ['boundSA', 'admin', 'globalSA']) {
    await db.authorizationContextSession.destroy({ where: { userId: f[k].user.id } })
    await db.user.destroy({ where: { id: f[k].user.id }, force: true })
  }
  await f.a.destroy({ force: true })
  await db.sequelize.close()
})

const sharedTypePayments = (name) => db.type_payment.findAll({ where: { name, store: null } })

describe.each([
  ['store-bound super_admin', 'boundSA'],
  ['admin', 'admin']
])('%s cannot write platform rows', (_label, key) => {
  test('creating a payment type never lands in the shared scope', async () => {
    for (const store of ['all', '', undefined]) {
      const name = uniq('NEW')
      const res = await as(f[key], 'post', '/type-payment/add-new-type-payment').send({ name, type: 'cash', ...(store !== undefined ? { store } : {}) })
      expect([200, 201, 403]).toContain(res.status)
      expect(await sharedTypePayments(name)).toHaveLength(0)
    }
  })

  test('editing its own payment type cannot move it to the shared scope', async () => {
    const own = await db.type_payment.create({ name: uniq('OWN'), store: f.a.id, type: 'cash', status: 'active' })
    await as(f[key], 'put', `/type-payment/edit-type-payment/${own.id}`).send({ name: own.name, type: 'cash', store: 'all' })
    expect((await db.type_payment.findByPk(own.id)).store).toBe(f.a.id)
  })

  test('platform payment type, tax and role cannot be edited or deleted', async () => {
    expect((await as(f[key], 'put', `/type-payment/edit-type-payment/${f.tp.id}`).send({ name: `${f.tp.name}x`, type: 'cash' })).status).toBe(403)
    expect((await as(f[key], 'delete', `/type-payment/delete-type-payment/${f.tp.id}`)).status).toBe(403)
    expect(await db.type_payment.findByPk(f.tp.id)).not.toBeNull()

    expect((await as(f[key], 'put', `/tax-config/edit-tax-config/${f.tax.id}`).send({ name: f.tax.name, rate: 99 })).status).toBe(403)
    expect((await as(f[key], 'delete', `/tax-config/delete-tax-config/${f.tax.id}`)).status).toBe(403)
    expect((await db.taxConfig.findByPk(f.tax.id)).rate).toBe(11)

    expect((await as(f[key], 'put', `/role/edit-role/${f.role.id}`).send({ name: `${f.role.name}x` })).status).toBe(403)
    expect((await as(f[key], 'delete', `/role/delete-role/${f.role.id}`)).status).toBe(403)
    expect((await db.role.findByPk(f.role.id)).name).toBe(f.role.name)
  })

  test('creating a tax config or role stays on its own outlet', async () => {
    const taxName = uniq('TX')
    await as(f[key], 'post', '/tax-config/add-new-tax-config').send({ name: taxName, rate: 5, type: 'other' })
    expect(await db.taxConfig.count({ where: { name: taxName, store: null } })).toBe(0)
    await db.taxConfig.destroy({ where: { name: taxName }, force: true })

    const roleName = uniq('RL')
    await as(f[key], 'post', '/role/add-new-role').send({ name: roleName, roleType: 'kasir', store: null })
    expect(await db.role.count({ where: { name: roleName, store: null } })).toBe(0)
    await db.role.destroy({ where: { name: roleName }, force: true })
  })
})

test('tenant users still read the platform payment type', async () => {
  const res = await as(f.admin, 'get', '/type-payment/get-by-id/' + f.tp.id)
  expect(res.status).toBe(200)
  expect(res.body.data?.id).toBe(f.tp.id)
})

test('a global super_admin still manages platform payment types', async () => {
  const name = uniq('GLB')
  const created = await as(f.globalSA, 'post', '/type-payment/add-new-type-payment').send({ name, type: 'cash', store: 'all' })
  expect(created.status).toBe(200)
  expect(await sharedTypePayments(name)).toHaveLength(1)
  const del = await as(f.globalSA, 'delete', `/type-payment/delete-type-payment/${f.tp.id}`)
  expect(del.status).toBe(200)
  expect(await db.type_payment.findByPk(f.tp.id)).toBeNull()
})
