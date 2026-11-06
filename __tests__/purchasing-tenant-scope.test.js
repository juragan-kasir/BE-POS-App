'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Wave 4 by-id sweep: purchase returns, purchase payments and accounts
// receivable skipped the store filter for every super_admin, so a
// store-bound owner read and changed another tenant's records. By-id routes
// are covered by tenant-by-id-sweep.test.js; this file pins the list and
// create paths that had the same bypass.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) =>
  `pts_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const ids = { tenants: [], stores: [], users: [], orders: [], ars: [], pos: [] }
let storeA
let storeB
let tokenOwnerA

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
  const owner = await db.user.create({
    userName: uniq('owner'),
    email: `${uniq('owner')}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active',
    store: storeA.id
  })
  ids.users.push(owner.id)
  await db.tenantMembership.create({
    userId: owner.id,
    tenantId: tA.id,
    role: 'tenant_admin',
    status: 'ACTIVE'
  })
  tokenOwnerA = await signSessionToken(
    {
      id: owner.id,
      userName: owner.userName,
      roleType: 'super_admin',
      store: storeA.id
    },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.purchase_return.destroy({
    where: { purchaseOrder: ids.pos },
    force: true
  })
  await db.purchase_order.destroy({ where: { id: ids.pos }, force: true })
  await db.accounts_receivable.destroy({ where: { id: ids.ars }, force: true })
  await db.order.destroy({ where: { id: ids.orders }, force: true })
  await db.tenantMembership.destroy({
    where: { userId: ids.users },
    force: true
  })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

const as = (method, path) =>
  request(app)[method](path).set('Authorization', `Bearer ${tokenOwnerA}`)

const arIn = async (store) => {
  const order = await db.order.create({
    orderNumber: uniq('ORD'),
    store,
    status: 'pending',
    paymentStatus: 'unpaid'
  })
  ids.orders.push(order.id)
  const ar = await db.accounts_receivable.create({
    orderId: order.id,
    store,
    status: 'UNPAID'
  })
  ids.ars.push(ar.id)
  return ar
}

describe('purchasing records are tenant-scoped for the store-bound owner', () => {
  test("the receivables list and aging never show another tenant's receivable", async () => {
    const own = await arIn(storeA.id)
    const foreign = await arIn(storeB.id)
    const list = await as('get', '/accounts-receivable/list?limit=1000')
    expect(list.status).toBe(200)
    const text = JSON.stringify(list.body)
    expect(text).toContain(`"id":${own.id}`)
    expect(text).not.toContain(`"id":${foreign.id},`)
    const aging = await as('get', '/accounts-receivable/aging')
    expect(aging.status).toBe(200)
    expect(JSON.stringify(aging.body)).not.toContain(`"id":${foreign.id},`)
  })

  test("a purchase return cannot be raised against another tenant's purchase order", async () => {
    const poB = await db.purchase_order.create({
      orderNumber: uniq('PO'),
      store: storeB.id,
      status: 'received'
    })
    ids.pos.push(poB.id)
    const res = await as('post', '/purchase-return/create').send({
      purchaseOrder: poB.id,
      reason: 'sweep',
      items: [{ productId: 1, quantity: 1 }]
    })
    expect(res.status).toBe(403)
    expect(
      await db.purchase_return.count({ where: { purchaseOrder: poB.id } })
    ).toBe(0)
  })
})
