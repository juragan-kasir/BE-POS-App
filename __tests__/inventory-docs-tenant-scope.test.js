'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Wave 4 by-id sweep: goods requests, goods receipts, stock opnames and
// production orders skipped the store filter for every super_admin
// (`if (store && userRole !== 'super_admin') where.store = store`), so a
// store-bound owner read, changed and deleted another tenant's documents.
// The by-id routes are covered by tenant-by-id-sweep.test.js; this file
// pins the goods-receipt list, which had the same bypass.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) =>
  `ids_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const ids = { tenants: [], stores: [], users: [], pos: [], receipts: [] }
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
  await db.goodsReceipt.destroy({ where: { id: ids.receipts }, force: true })
  await db.purchase_order.destroy({ where: { id: ids.pos }, force: true })
  await db.tenantMembership.destroy({
    where: { userId: ids.users },
    force: true
  })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

const receiptIn = async (store) => {
  const po = await db.purchase_order.create({ orderNumber: uniq('PO'), store })
  ids.pos.push(po.id)
  const gr = await db.goodsReceipt.create({
    receiptNumber: uniq('GR'),
    purchaseOrderId: po.id,
    store
  })
  ids.receipts.push(gr.id)
  return gr
}

describe('goods receipt list is tenant-scoped for the store-bound owner', () => {
  test("listing without ?store shows the owner's receipts and never another tenant's", async () => {
    const own = await receiptIn(storeA.id)
    const foreign = await receiptIn(storeB.id)
    const res = await request(app)
      .get('/goods-receipt/get-all?limit=1000')
      .set('Authorization', `Bearer ${tokenOwnerA}`)
    expect(res.status).toBe(200)
    const seen = (res.body.data || []).map((r) => r.id)
    expect(seen).toContain(own.id)
    expect(seen).not.toContain(foreign.id)
  })
})
