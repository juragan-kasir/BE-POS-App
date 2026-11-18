'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W3-2 (BE audit S-04/S-05, migration 20261119000002 / batch B20): category
// and product_bundle carry their tenant, bundle SKUs are unique per tenant,
// and a bundle can only contain products of its own tenant.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const migration = require('../db/migrations/20261119000002-category-bundle-tenant-id')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) => `cbt_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const ids = { tenants: [], stores: [], users: [], categories: [], products: [], bundles: [] }
const f = {}

const mkOwner = async (tenant, store) => {
  const user = await db.user.create({
    userName: uniq('owner'), email: `${uniq('owner')}@test.com`, roleType: 'super_admin', userType: 'admin',
    status: 'active', store: store.id
  })
  ids.users.push(user.id)
  await db.tenantMembership.create({ userId: user.id, tenantId: tenant.id, role: 'tenant_admin', status: 'ACTIVE' })
  const token = await signSessionToken({ id: user.id, userName: user.userName, roleType: 'super_admin', store: store.id }, JWT_SECRET)
  return { user, token, store, tenant }
}

const mkProduct = async (tenantId, price = 10000) => {
  const p = await db.product.create({ nameProduct: uniq('p'), category: f.category.id, price, tenantId })
  ids.products.push(p.id)
  return p
}

const createBundle = (owner, body) =>
  request(app)
    .post(`/product-bundle/create?store=${owner.store.id}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ name: uniq('bundle'), bundlePrice: 15000, ...body })

beforeAll(async () => {
  f.tA = await db.tenant.create({ code: uniq('a').replace(/_/g, '-'), name: uniq('TA') })
  f.tB = await db.tenant.create({ code: uniq('b').replace(/_/g, '-'), name: uniq('TB') })
  ids.tenants.push(f.tA.id, f.tB.id)
  f.a1 = await db.location.create({ name: uniq('A1'), status: 'active', tenantId: f.tA.id })
  f.a2 = await db.location.create({ name: uniq('A2'), status: 'active', tenantId: f.tA.id })
  f.b1 = await db.location.create({ name: uniq('B1'), status: 'active', tenantId: f.tB.id })
  f.free = await db.location.create({ name: uniq('F'), status: 'active' })
  ids.stores.push(f.a1.id, f.a2.id, f.b1.id, f.free.id)
  f.category = await db.category.create({ name: uniq('CAT') })
  ids.categories.push(f.category.id)
  f.ownerA = await mkOwner(f.tA, f.a1)
  f.ownerB = await mkOwner(f.tB, f.b1)
  f.productA = await mkProduct(f.tA.id)
  f.productB = await mkProduct(f.tB.id, 99000)
  f.productFree = await mkProduct(null)
})

afterAll(async () => {
  const bundles = await db.product_bundle.findAll({
    where: { [db.Sequelize.Op.or]: [{ id: ids.bundles }, { name: { [db.Sequelize.Op.like]: 'cbt_%' } }] },
    attributes: ['id'],
    paranoid: false
  })
  const bids = bundles.map((b) => b.id)
  await db.product_bundle_item.destroy({ where: { bundleId: bids }, force: true })
  await db.product_bundle.destroy({ where: { id: bids }, force: true })
  await db.product.destroy({ where: { id: ids.products }, force: true })
  await db.category_store.destroy({ where: { category: ids.categories }, force: true })
  await db.category.destroy({ where: { id: ids.categories }, force: true })
  await db.tenantMembership.destroy({ where: { userId: ids.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.update({ store: null }, { where: { id: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
  await db.sequelize.close()
})

test('both tables carry tenantId + index; the global bundle SKU unique (and its duplicate) are gone', async () => {
  const [cols] = await db.sequelize.query(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'tenantId' AND table_name IN ('category', 'product_bundle') ORDER BY 1`
  )
  expect(cols.map((c) => c.table_name)).toEqual(['category', 'product_bundle'])
  const [idx] = await db.sequelize.query(
    `SELECT indexname FROM pg_indexes WHERE tablename IN ('category', 'product_bundle')
      AND indexname IN ('ix_category_tenant', 'ix_product_bundle_tenant', 'product_bundle_sku_key', 'product_bundle_sku',
                        'uq_product_bundle_tenant_sku', 'uq_product_bundle_tenantless_sku') ORDER BY 1`
  )
  expect(idx.map((r) => r.indexname)).toEqual([
    'ix_category_tenant', 'ix_product_bundle_tenant', 'uq_product_bundle_tenant_sku', 'uq_product_bundle_tenantless_sku'
  ])
})

describe('category tenant', () => {
  test('a category created at an outlet takes that outlet\'s tenant', async () => {
    const res = await request(app)
      .post(`/category/add-new-category?store=${f.a1.id}`)
      .set('Authorization', `Bearer ${f.ownerA.token}`)
      .send({ name: uniq('catA'), store: [f.a1.id] })
    expect(res.status).toBe(200)
    ids.categories.push(res.body.data.id)
    expect((await db.category.findByPk(res.body.data.id)).tenantId).toBe(f.tA.id)
  })

  test('assigning outlets later adopts the tenant; tenant-less outlets leave it NULL', async () => {
    const cat = await db.category.create({ name: uniq('later') })
    const free = await db.category.create({ name: uniq('free') })
    ids.categories.push(cat.id, free.id)
    expect(cat.tenantId ?? null).toBeNull()
    await db.category_store.bulkCreate([{ category: cat.id, store: f.a1.id }, { category: cat.id, store: f.a2.id }])
    await db.category_store.create({ category: free.id, store: f.free.id })
    expect((await db.category.findByPk(cat.id)).tenantId).toBe(f.tA.id)
    expect((await db.category.findByPk(free.id)).tenantId).toBeNull()
  })

  test('a cross-tenant assignment is still refused and does not change the tenant', async () => {
    const cat = await db.category.create({ name: uniq('x') })
    ids.categories.push(cat.id)
    await db.category_store.create({ category: cat.id, store: f.a1.id })
    await expect(db.category_store.create({ category: cat.id, store: f.b1.id })).rejects.toThrow(/cross-tenant/)
    expect((await db.category.findByPk(cat.id)).tenantId).toBe(f.tA.id)
  })
})

describe('bundle tenant', () => {
  test('a bundle created at an outlet takes that outlet\'s tenant', async () => {
    const res = await createBundle(f.ownerA, { items: [{ product: f.productA.id, quantity: 2 }] })
    expect(res.status).toBe(201)
    ids.bundles.push(res.body.data.id)
    const row = await db.product_bundle.findByPk(res.body.data.id)
    expect(row.tenantId).toBe(f.tA.id)
    expect(row.originalPrice).toBe(20000)
  })

  test('another tenant\'s product is refused like a missing one (no price leak), and nothing is written', async () => {
    const before = await db.product_bundle.count()
    const res = await createBundle(f.ownerA, { items: [{ product: f.productB.id, quantity: 1 }] })
    expect(res.status).toBe(400)
    expect(res.body.message).toBe(`Produk ID ${f.productB.id} tidak ditemukan`)
    expect(JSON.stringify(res.body)).not.toContain('99000')
    expect(await db.product_bundle.count()).toBe(before)
  })

  test('tenant-less products stay usable', async () => {
    const res = await createBundle(f.ownerA, { items: [{ product: f.productFree.id, quantity: 1 }] })
    expect(res.status).toBe(201)
    ids.bundles.push(res.body.data.id)
  })

  test('update with a foreign product keeps the existing items (validated before delete)', async () => {
    const created = await createBundle(f.ownerA, { items: [{ product: f.productA.id, quantity: 1 }] })
    ids.bundles.push(created.body.data.id)
    const res = await request(app)
      .put(`/product-bundle/update/${created.body.data.id}?store=${f.a1.id}`)
      .set('Authorization', `Bearer ${f.ownerA.token}`)
      .send({ items: [{ product: f.productB.id, quantity: 1 }] })
    expect(res.status).toBe(400)
    const items = await db.product_bundle_item.findAll({ where: { bundleId: created.body.data.id } })
    expect(items.map((i) => i.product)).toEqual([f.productA.id])
  })

  test('the model refuses a bundle spanning two tenants', async () => {
    await expect(
      db.product_bundle.create({ name: uniq('span'), sku: uniq('S'), store: [f.a1.id, f.b1.id], bundlePrice: 1 })
    ).rejects.toMatchObject({ code: 'BUNDLE_STORE_CROSS_TENANT' })
  })

  test('changing the outlets of a bundle re-derives its tenant', async () => {
    const bundle = await db.product_bundle.create({ name: uniq('mv'), sku: uniq('M'), store: [f.a1.id], bundlePrice: 1 })
    ids.bundles.push(bundle.id)
    expect(bundle.tenantId).toBe(f.tA.id)
    await bundle.update({ store: [f.a2.id] })
    expect((await db.product_bundle.findByPk(bundle.id)).tenantId).toBe(f.tA.id)
  })

  test('bundle SKUs are unique per tenant, and globally among tenant-less bundles', async () => {
    const sku = uniq('SKU').toUpperCase()
    const a = await db.product_bundle.create({ name: uniq('a'), sku, store: [f.a1.id], bundlePrice: 1 })
    const b = await db.product_bundle.create({ name: uniq('b'), sku, store: [f.b1.id], bundlePrice: 1 })
    ids.bundles.push(a.id, b.id)
    expect([a.tenantId, b.tenantId]).toEqual([f.tA.id, f.tB.id])
    await expect(db.product_bundle.create({ name: uniq('a2'), sku, store: [f.a2.id], bundlePrice: 1 })).rejects.toThrow()

    const tl = uniq('TL').toUpperCase()
    const t1 = await db.product_bundle.create({ name: uniq('t1'), sku: tl, store: null, bundlePrice: 1 })
    ids.bundles.push(t1.id)
    await expect(db.product_bundle.create({ name: uniq('t2'), sku: tl, store: null, bundlePrice: 1 })).rejects.toThrow()
  })
})

test('the backfill sets the tenant only when every outlet agrees, and is replay-safe', async () => {
  const catOne = await db.category.create({ name: uniq('bf1') })
  const catCross = await db.category.create({ name: uniq('bf2') })
  ids.categories.push(catOne.id, catCross.id)
  // Raw SQL bypasses the hooks: simulates pre-W3-2 / pre-GAP-3 data.
  await db.sequelize.query(
    `INSERT INTO category_store (category, store, "createdAt", "updatedAt")
     VALUES (:one, :a, NOW(), NOW()), (:cross, :a, NOW(), NOW()), (:cross, :b, NOW(), NOW())`,
    { replacements: { one: catOne.id, cross: catCross.id, a: f.a1.id, b: f.b1.id } }
  )
  const [[bArr], [bNum], [bCross], [bFree]] = await Promise.all(
    [`'[${f.a1.id}, ${f.a2.id}]'`, `'${f.b1.id}'`, `'[${f.a1.id}, ${f.b1.id}]'`, `'[${f.free.id}]'`].map((store) =>
      db.sequelize.query(
        `INSERT INTO product_bundle (name, sku, store, "bundlePrice", "createdAt", "updatedAt")
         VALUES ('${uniq('raw')}', '${uniq('R')}', ${store}::jsonb, 1, NOW(), NOW()) RETURNING id`,
        { type: db.sequelize.QueryTypes.SELECT }
      )
    )
  )
  ids.bundles.push(bArr.id, bNum.id, bCross.id, bFree.id)

  await migration.up(db.sequelize.getQueryInterface(), db.Sequelize)
  await migration.up(db.sequelize.getQueryInterface(), db.Sequelize)

  expect((await db.category.findByPk(catOne.id)).tenantId).toBe(f.tA.id)
  expect((await db.category.findByPk(catCross.id)).tenantId).toBeNull()
  const tenantOf = async (id) => (await db.product_bundle.findByPk(id)).tenantId
  expect(await tenantOf(bArr.id)).toBe(f.tA.id)
  expect(await tenantOf(bNum.id)).toBe(f.tB.id)
  expect(await tenantOf(bCross.id)).toBeNull()
  expect(await tenantOf(bFree.id)).toBeNull()
})
