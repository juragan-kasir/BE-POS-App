'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// List endpoints for a client owner (store-bound super_admin). Found by the
// 10-owner multi-tenant E2E (2026-11-11): without ?store= ("Semua toko") these
// lists fell back to "no store filter" for any super_admin and returned every
// tenant's rows; dead stock listed every tenant's products for any role.
// Owner of tenant A (outlets A1 + A2) must see A1 and A2, never tenant B; the
// global super_admin keeps seeing everything.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const unique = (p) => `${p}_${RUN}_${Math.floor(Math.random() * 1e6)}`

const tenants = []
const stores = {}
const users = []
const tokens = {}
const rows = { table: {}, typePayment: {}, discount: {}, socialMedia: {}, waiter: {}, history: {}, product: {} }
let category
let invoiceB

const get = (who, url) =>
  request(app).get(url).set('Authorization', `Bearer ${tokens[who]}`)
const listOf = (body) => {
  const d = body?.data
  if (Array.isArray(d)) return d
  return d?.tables || d?.rows || d?.items || d?.data || []
}
const idsOf = (res) => listOf(res.body).map((r) => r.id ?? r.productId)

beforeAll(async () => {
  for (const tag of ['A', 'B']) {
    tenants.push(
      await db.tenant.create({
        code: unique(`SL${tag}`).toUpperCase().slice(0, 30),
        name: unique(`SL${tag}`)
      })
    )
  }
  for (const [key, t] of [['A1', 0], ['A2', 0], ['B', 1]]) {
    stores[key] = await db.location.create({
      name: unique(`SL_STORE_${key}`),
      status: 'active',
      tenantId: tenants[t].id
    })
  }
  category = await db.category.create({ name: unique('SL_CAT') })
  for (const key of ['A1', 'A2', 'B']) {
    const store = stores[key].id
    rows.table[key] = await db.table.create({ name: unique(`T_${key}`), store, status: 'available', capacity: 4 })
    rows.typePayment[key] = await db.type_payment.create({ name: unique(`TP_${key}`), store, type: 'cash', status: 'active' })
    rows.discount[key] = await db.discount.create({ name: unique(`D_${key}`), store, type: 'percent', value: 5, status: 'active' })
    rows.socialMedia[key] = await db.social_media.create({ name: unique(`SM_${key}`), store })
    rows.waiter[key] = await db.waiter_request.create({ requestNumber: `WR${key}${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 1e4)}`, type: 'tisu', status: 'pending', store: [store] })
    const p = await db.product.create({ nameProduct: unique(`P_${key}`), category: category.id, price: 10000, costPrice: 6000, stock: 10, status: 'active' })
    await db.product_store.create({ product: p.id, store })
    await db.product_store_stock.create({ product: p.id, store, stock: 10 })
    rows.product[key] = p
    rows.history[key] = await db.stock_history.create({ store, product: p.id, referenceType: 'adjustment', quantityChange: 10, quantityAfter: 10 })
  }
  invoiceB = await db.invoice_setting.create({ store: stores.B.id, footer: unique('FOOTER_B') })

  const owner = await db.user.create({
    userName: unique('sl_owner'),
    email: `${unique('sl_owner')}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active',
    store: stores.A1.id
  })
  await db.tenantMembership.create({ userId: owner.id, tenantId: tenants[0].id, role: 'tenant_admin', status: 'ACTIVE' })
  const platform = await db.user.create({
    userName: unique('sl_platform'),
    email: `${unique('sl_platform')}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active',
    store: null
  })
  const admin = await db.user.create({
    userName: unique('sl_admin'),
    email: `${unique('sl_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    status: 'active',
    store: stores.A1.id
  })
  users.push(owner, platform, admin)
  for (const [who, u] of [['owner', owner], ['platform', platform], ['admin', admin]]) {
    tokens[who] = await signSessionToken(
      { id: u.id, userName: u.userName, roleType: u.roleType, store: u.store },
      JWT_SECRET
    )
  }
})

afterAll(async () => {
  const storeIds = Object.values(stores).map((s) => s.id)
  const productIds = Object.values(rows.product).map((p) => p.id)
  const userIds = users.map((u) => u.id)
  const quiet = (p) => Promise.resolve(p).catch(() => {})
  await quiet(db.stock_history.destroy({ where: { product: productIds }, force: true }))
  await quiet(db.product_store_stock.destroy({ where: { product: productIds }, force: true }))
  await quiet(db.product_store.destroy({ where: { product: productIds }, force: true }))
  await quiet(db.product.destroy({ where: { id: productIds }, force: true }))
  await quiet(db.category.destroy({ where: { id: category?.id }, force: true }))
  await quiet(db.invoice_setting.destroy({ where: { id: invoiceB?.id }, force: true }))
  for (const model of ['table', 'type_payment', 'discount', 'social_media']) {
    await quiet(db[model].destroy({ where: { store: storeIds }, force: true }))
  }
  await quiet(db.waiter_request.destroy({ where: { id: Object.values(rows.waiter).map((w) => w.id) }, force: true }))
  await quiet(db.tenantMembership.destroy({ where: { userId: userIds } }))
  await quiet(db.authorizationContextSession.destroy({ where: { userId: userIds } }))
  await quiet(db.user.destroy({ where: { id: userIds }, force: true }))
  await quiet(db.location.destroy({ where: { id: storeIds }, force: true }))
  await quiet(db.tenant.destroy({ where: { id: tenants.map((t) => t.id) }, force: true }))
})

const LISTS = [
  ['tables with orders', '/table/get-tables-with-orders', 'table'],
  ['table availability', '/table/get-availability', 'table'],
  ['active payment types', '/type-payment/get-type-payment?limit=500', 'typePayment'],
  ['payment type list', '/type-payment/get-list-type-payment?limit=500', 'typePayment'],
  ['active discounts', '/discount/get-discount-by-location?size=500', 'discount'],
  ['discount list', '/discount/get-discount?limit=500', 'discount'],
  ['social media', '/social-media/get-social-media?size=500', 'socialMedia'],
  ['pending waiter requests', '/waiter-request/pending?limit=500', 'waiter'],
  ['waiter requests', '/waiter-request?limit=500', 'waiter'],
  ['stock history', '/stock-history/get-all?limit=500', 'history']
]

describe('client owner (store-bound super_admin) of tenant A, no ?store=', () => {
  test.each(LISTS)('%s: both own outlets, never tenant B', async (_, url, kind) => {
    const res = await get('owner', url)
    expect(res.status).toBe(200)
    const ids = idsOf(res)
    expect(ids).toEqual(expect.arrayContaining([rows[kind].A1.id, rows[kind].A2.id]))
    expect(ids).not.toContain(rows[kind].B.id)
  })

  test("invoice setting never returns tenant B's row", async () => {
    const res = await get('owner', '/invoice/setting')
    expect(res.status).toBe(200)
    expect(res.body.data.id).not.toBe(invoiceB.id)
    expect(res.body.data.isDefault).toBe(true)
  })

  test("a ?store= of tenant B is refused or matches nothing", async () => {
    for (const [, url, kind] of LISTS) {
      const sep = url.includes('?') ? '&' : '?'
      const res = await get('owner', `${url}${sep}store=${stores.B.id}`)
      if (res.status === 200) expect(idsOf(res)).not.toContain(rows[kind].B.id)
      else expect(res.status).toBe(403)
    }
  })
})

describe('dead stock', () => {
  test.each(['owner', 'admin'])("%s: only the outlet's own products", async (who) => {
    const res = await get(who, `/inventory/dead-stock?store=${stores.A1.id}&threshold=1`)
    expect(res.status).toBe(200)
    const ids = idsOf(res)
    expect(ids).toContain(rows.product.A1.id)
    expect(ids).not.toContain(rows.product.A2.id)
    expect(ids).not.toContain(rows.product.B.id)
  })
})

describe('global super_admin (vendor) keeps the platform view', () => {
  test.each(LISTS)('%s: sees tenant B too', async (_, url, kind) => {
    const res = await get('platform', url)
    expect(res.status).toBe(200)
    expect(idsOf(res)).toEqual(expect.arrayContaining([rows[kind].A1.id, rows[kind].B.id]))
  })
})
