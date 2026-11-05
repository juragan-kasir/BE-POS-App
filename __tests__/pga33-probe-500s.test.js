'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-33 (harness recheck 2026-11-04): two requests answered 500 instead of
// a 4xx. Neither wrote anything, but a 500 hides the real answer:
// - DELETE /product/delete-product/:id without a body id → WHERE id = undefined
// - PUT /location/edit-location with a numeric locationId → rawId.replace crash
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (p) => `pga33_${p}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const ids = { tenants: [], stores: [], users: [], products: [], categories: [] }
let own
let foreign
let ownProduct
let foreignProduct
let ownerToken

const makeProduct = async (store, category) => {
  const p = await db.product.create({ nameProduct: uniq('P'), category, price: 1000, stock: 10 })
  await db.product_store.create({ product: p.id, store: store.id })
  ids.products.push(p.id)
  return p
}

beforeAll(async () => {
  const tenant = await db.tenant.create({ code: uniq('T').toUpperCase(), name: uniq('Tenant') })
  const other = await db.tenant.create({ code: uniq('O').toUpperCase(), name: uniq('Other') })
  ids.tenants.push(tenant.id, other.id)
  own = await db.location.create({ name: uniq('OWN'), status: 'active', tenantId: tenant.id })
  foreign = await db.location.create({ name: uniq('FOREIGN'), status: 'active', tenantId: other.id })
  ids.stores.push(own.id, foreign.id)
  const category = await db.category.create({ name: uniq('CAT') })
  ids.categories.push(category.id)
  ownProduct = await makeProduct(own, category.id)
  foreignProduct = await makeProduct(foreign, category.id)

  const owner = await db.user.create({
    userName: uniq('owner'),
    email: `${uniq('owner')}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active',
    store: own.id
  })
  ids.users.push(owner.id)
  await db.tenantMembership.create({ userId: owner.id, tenantId: tenant.id, role: 'tenant_admin', status: 'ACTIVE' })
  ownerToken = await signSessionToken({ id: owner.id, userName: owner.userName, roleType: 'super_admin', store: own.id }, JWT_SECRET)
})

afterAll(async () => {
  await db.product_store.destroy({ where: { product: ids.products }, force: true })
  await db.product.destroy({ where: { id: ids.products }, force: true })
  await db.category.destroy({ where: { id: ids.categories }, force: true })
  await db.tenantMembership.destroy({ where: { userId: ids.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

const as = (method, path) => request(app)[method](path).set('Authorization', `Bearer ${ownerToken}`)

describe('PGA-33: refused probes answer 4xx, not 500', () => {
  test("deleting another tenant's product by path id is a 404 and deletes nothing", async () => {
    const res = await as('delete', `/product/delete-product/${foreignProduct.id}`)
    expect(res.status).toBe(404)
    expect(await db.product.findByPk(foreignProduct.id)).not.toBeNull()
  })

  test('deleting an own product works with the path id alone', async () => {
    const res = await as('delete', `/product/delete-product/${ownProduct.id}`)
    expect(res.status).toBe(200)
    expect(await db.product.findByPk(ownProduct.id)).toBeNull()
  })

  test('a non-numeric product id is a 400', async () => {
    const res = await as('delete', '/product/delete-product/abc')
    expect(res.status).toBe(400)
  })

  test('edit-location accepts a numeric locationId', async () => {
    const res = await as('put', '/location/edit-location').send({ locationId: own.id, name: uniq('RENAMED') })
    expect(res.status).toBeLessThan(500)
    expect(res.status).toBe(200)
  })

  test("a numeric id for another tenant's outlet is refused with a 4xx and changes nothing", async () => {
    const res = await as('put', '/location/edit-location').send({ locationId: foreign.id, name: 'HACKED' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect((await db.location.findByPk(foreign.id)).name).not.toBe('HACKED')
  })
})
