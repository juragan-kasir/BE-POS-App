process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { backfillTenant } = require('../db/migrations/20261103000001-promo-campaign-tenant')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// PGA-03 / ADR-02 (audit product-grade-2026-11-02, WAVE-0-DECISIONS): a
// campaign with store null ("all outlets") gave a discount at EVERY tenant's
// checkout (Toko Berkah −160,000/day) and was listed, editable and
// deletable by other tenants' owners. A campaign now belongs to one tenant
// (promo_campaign.tenantId, batch B11) and "all outlets" means that
// tenant's outlets only.

const PREFIX = `w1p3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const DAY = 86400000

const ids = { tenants: [], stores: [], users: [], products: [], categories: [], campaigns: [] }
const s = {}
const t = {}

const makeStore = async (key, tenantId) => {
  const row = await db.location.create({ name: unique(key), status: 'active', tenantId })
  ids.stores.push(row.id)
  return row
}

const makeUser = async (key, roleType, store) => {
  const name = unique(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: 'Rahasia123!',
    fullName: name,
    roleType,
    userType: 'admin',
    status: 'active',
    store
  })
  ids.users.push(row.id)
  return { row, token: await signSessionToken({ id: row.id, roleType, store }, JWT_SECRET) }
}

const as = (token) => ({ Authorization: `Bearer ${token}` })

const createCampaign = (token, body = {}) =>
  request(app)
    .post('/promo/campaigns')
    .set(as(token))
    .send({
      store: null,
      name: unique('PROMO'),
      type: 'manual',
      status: 'active',
      startDate: new Date(Date.now() - DAY).toISOString(),
      endDate: new Date(Date.now() + DAY).toISOString(),
      priority: 999,
      rewards: [{ rewardType: 'discount_fixed', rewardValue: 4500 }],
      ...body
    })

const quoteDiscount = async (token, store) => {
  const res = await request(app)
    .post('/order/quote')
    .set(as(token))
    .send({ store: store.id, items: [{ product: s.productOf[store.id].id, quantity: 1 }] })
  if (res.status !== 200) throw new Error(`quote ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data.discountAmount
}

beforeAll(async () => {
  const tenantA = await db.tenant.create({ code: unique('TA').toUpperCase(), name: unique('Tenant A') })
  const tenantB = await db.tenant.create({ code: unique('TB').toUpperCase(), name: unique('Tenant B') })
  ids.tenants.push(tenantA.id, tenantB.id)
  s.tenantA = tenantA
  s.tenantB = tenantB
  s.a1 = await makeStore('A1', tenantA.id)
  s.a2 = await makeStore('A2', tenantA.id)
  s.b1 = await makeStore('B1', tenantB.id)

  t.ownerA = await makeUser('owner_a', 'super_admin', s.a1.id)
  t.adminA2 = await makeUser('admin_a2', 'admin', s.a2.id)
  t.ownerB = await makeUser('owner_b', 'super_admin', s.b1.id)
  t.adminB1 = await makeUser('admin_b1', 'admin', s.b1.id)
  t.vendor = await makeUser('vendor', 'super_admin', null)

  s.category = await db.category.create({ name: unique('CAT'), status: 'active' })
  ids.categories.push(s.category.id)
  // A product never spans tenants (product_store guard): one per tenant.
  const productA = await db.product.create({ nameProduct: unique('PROD_A'), category: s.category.id, price: 50000, stock: 1000 })
  const productB = await db.product.create({ nameProduct: unique('PROD_B'), category: s.category.id, price: 50000, stock: 1000 })
  ids.products.push(productA.id, productB.id)
  s.productOf = { [s.a1.id]: productA, [s.a2.id]: productA, [s.b1.id]: productB }
  for (const store of [s.a1, s.a2, s.b1]) {
    await db.product_store.create({ product: s.productOf[store.id].id, store: store.id })
    await db.product_store_stock.create({ product: s.productOf[store.id].id, store: store.id, stock: 1000 })
    await db.taxConfig.create({ store: store.id, name: unique('PPN'), rate: 11, type: 'ppn', status: 'active' })
  }

  const res = await createCampaign(t.ownerA.token)
  expect(res.status).toBe(201)
  s.campaignA = res.body.data
  ids.campaigns.push(s.campaignA.id)
  // The create schema drops `status` (audit PGA-16): activate explicitly.
  const activated = await request(app)
    .put(`/promo/campaigns/${s.campaignA.id}/status`)
    .set(as(t.ownerA.token))
    .send({ status: 'active' })
  expect(activated.status).toBe(200)
})

afterAll(async () => {
  await db.promo_reward.destroy({ where: { campaignId: ids.campaigns }, force: true })
  await db.promo_rule.destroy({ where: { campaignId: ids.campaigns }, force: true })
  await db.promo_campaign.destroy({ where: { id: ids.campaigns }, force: true })
  await db.taxConfig.destroy({ where: { store: ids.stores }, force: true })
  await db.product_store_stock.destroy({ where: { product: ids.products }, force: true })
  await db.product_store.destroy({ where: { product: ids.products } })
  await db.product.destroy({ where: { id: ids.products }, force: true })
  await db.category.destroy({ where: { id: ids.categories }, force: true })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

describe('a campaign belongs to its creator\'s tenant', () => {
  test('"all outlets" from owner A is stored as tenant A', async () => {
    const row = await db.promo_campaign.findByPk(s.campaignA.id)
    expect(row.tenantId).toBe(s.tenantA.id)
    expect(row.store).toBeNull()
  })

  test('it discounts every outlet of tenant A and no outlet of tenant B', async () => {
    expect(await quoteDiscount(t.ownerA.token, s.a1)).toBe(4500)
    expect(await quoteDiscount(t.adminA2.token, s.a2)).toBe(4500)
    expect(await quoteDiscount(t.adminB1.token, s.b1)).toBe(0)
  })

  test('the diner app lists it for tenant A outlets only, and nothing without an outlet', async () => {
    const listed = async (query) =>
      ((await request(app).get(`/promo/customer-active${query}`)).body.data || []).map((c) => c.id)
    expect(await listed(`?store=${s.a2.id}`)).toContain(s.campaignA.id)
    expect(await listed(`?store=${s.b1.id}`)).not.toContain(s.campaignA.id)
    expect(await listed('')).toEqual([])
  })

  test('tenant B cannot list, read, edit, pause or delete it', async () => {
    const list = await request(app).get('/promo/campaigns?page=1&limit=100').set(as(t.ownerB.token))
    expect(list.status).toBe(200)
    expect((list.body.data || []).map((c) => c.id)).not.toContain(s.campaignA.id)

    const id = s.campaignA.id
    expect((await request(app).get(`/promo/campaigns/${id}`).set(as(t.ownerB.token))).status).toBe(404)
    expect((await request(app).put(`/promo/campaigns/${id}`).set(as(t.ownerB.token)).send({ name: 'HACKED' })).status).toBe(404)
    expect((await request(app).put(`/promo/campaigns/${id}/status`).set(as(t.ownerB.token)).send({ status: 'paused' })).status).toBe(404)
    expect((await request(app).delete(`/promo/campaigns/${id}`).set(as(t.ownerB.token))).status).toBe(404)

    const row = await db.promo_campaign.findByPk(id)
    expect(row.name).toBe(s.campaignA.name)
    expect(row.status).toBe('active')
  })

  test('an edit cannot move it to another tenant', async () => {
    const res = await request(app)
      .put(`/promo/campaigns/${s.campaignA.id}`)
      .set(as(t.ownerA.token))
      .send({ tenantId: s.tenantB.id, name: unique('RENAMED') })
    expect(res.status).toBe(200)
    expect((await db.promo_campaign.findByPk(s.campaignA.id)).tenantId).toBe(s.tenantA.id)
  })
})

describe('who may create what', () => {
  test('owner A cannot create a campaign for tenant B\'s outlet', async () => {
    const res = await createCampaign(t.ownerA.token, { store: s.b1.id })
    expect([403]).toContain(res.status)
    expect(await db.promo_campaign.count({ where: { store: s.b1.id, createdBy: t.ownerA.row.id } })).toBe(0)
  })

  test('the platform vendor cannot create a merchant campaign (ADR-02)', async () => {
    const res = await createCampaign(t.vendor.token, { store: s.a1.id })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('PROMO_VENDOR_FORBIDDEN')
  })

  test('a vendor "all outlets" campaign is tenant-less and discounts no merchant', async () => {
    const res = await createCampaign(t.vendor.token)
    expect(res.status).toBe(201)
    ids.campaigns.push(res.body.data.id)
    await db.promo_campaign.update({ status: 'active' }, { where: { id: res.body.data.id } })
    expect((await db.promo_campaign.findByPk(res.body.data.id)).tenantId).toBeNull()
    expect(await quoteDiscount(t.adminB1.token, s.b1)).toBe(0)
  })
})

describe('B11 backfill', () => {
  const insert = async (fields) => {
    const row = await db.promo_campaign.create({
      name: unique('LEGACY'),
      type: 'manual',
      status: 'draft',
      startDate: new Date(),
      endDate: new Date(Date.now() + DAY),
      ...fields
    })
    ids.campaigns.push(row.id)
    await db.sequelize.query('UPDATE promo_campaign SET "tenantId" = NULL WHERE id = ?', { replacements: [row.id] })
    return row.id
  }
  const tenantOf = async (id) => (await db.promo_campaign.findByPk(id)).tenantId

  test('fills the tenant from the outlets, else from the creator; leaves ambiguous rows NULL', async () => {
    const scalar = await insert({ store: s.a2.id })
    const array = await insert({ store: [s.a1.id, s.a2.id] })
    const span = await insert({ store: [s.a1.id, s.b1.id] })
    const byCreator = await insert({ store: null, createdBy: t.ownerB.row.id })
    const vendorMade = await insert({ store: null, createdBy: t.vendor.row.id })

    await db.sequelize.transaction((transaction) =>
      backfillTenant(db.sequelize.getQueryInterface(), transaction)
    )

    expect(await tenantOf(scalar)).toBe(s.tenantA.id)
    expect(await tenantOf(array)).toBe(s.tenantA.id)
    expect(await tenantOf(span)).toBeNull()
    expect(await tenantOf(byCreator)).toBe(s.tenantB.id)
    expect(await tenantOf(vendorMade)).toBeNull()
  })

  test('replays without changing a filled row', async () => {
    const before = await tenantOf(s.campaignA.id)
    await db.sequelize.transaction((transaction) =>
      backfillTenant(db.sequelize.getQueryInterface(), transaction)
    )
    expect(await tenantOf(s.campaignA.id)).toBe(before)
  })
})
