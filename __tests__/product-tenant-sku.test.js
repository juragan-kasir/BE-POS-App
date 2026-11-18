'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W3-1 (BE audit S-04/S-05, migration 20261119000001 / batch B19): a product
// carries its tenant and SKUs are unique per tenant. Tenant B may use a SKU
// tenant A already uses — and never learns that A uses it.
const request = require('supertest')
const ExcelJS = require('exceljs')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const migration = require('../db/migrations/20261119000001-product-tenant-id')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) => `pts_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const HEADERS = ['No.', 'Nama Produk', 'SKU', 'Barcode', 'Brand/Merek', 'Kategori', 'Tipe Produk', 'Deskripsi', 'Store',
  'Satuan', 'Base Satuan', 'Faktor Konversi', 'Supplier', 'Pajak', 'Harga', 'Harga Beli', 'Stok', 'Min Stok', 'Point',
  'Point Redeem', 'Status', 'Tersedia', 'Opsi', 'Daftar Opsi']
const ids = { tenants: [], stores: [], users: [], categories: [] }
const f = {}

const sheet = async (rows) => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Produk')
  ws.addRow(HEADERS)
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''))
  return Buffer.from(await wb.xlsx.writeBuffer())
}
const row = (o) => ({
  Kategori: f.category.name, 'Tipe Produk': 'barang', Satuan: 'pcs', 'Base Satuan': 'pcs', 'Faktor Konversi': 1,
  Harga: 1000, Status: 'Aktif', Tersedia: 'Ya', Opsi: 'Tidak', ...o
})
const importAs = async (owner, rows) =>
  request(app)
    .post(`/product/import?store=${owner.store.id}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .attach('file', await sheet(rows), 'produk.xlsx')

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

beforeAll(async () => {
  f.tA = await db.tenant.create({ code: uniq('a').replace(/_/g, '-'), name: uniq('TA') })
  f.tB = await db.tenant.create({ code: uniq('b').replace(/_/g, '-'), name: uniq('TB') })
  ids.tenants.push(f.tA.id, f.tB.id)
  f.a1 = await db.location.create({ name: uniq('A1'), status: 'active', tenantId: f.tA.id })
  f.b1 = await db.location.create({ name: uniq('B1'), status: 'active', tenantId: f.tB.id })
  ids.stores.push(f.a1.id, f.b1.id)
  f.category = await db.category.create({ name: uniq('CAT') })
  ids.categories.push(f.category.id)
  f.ownerA = await mkOwner(f.tA, f.a1)
  f.ownerB = await mkOwner(f.tB, f.b1)
})

afterAll(async () => {
  const products = await db.product.findAll({ where: { tenantId: ids.tenants }, attributes: ['id'], paranoid: false })
  const extra = await db.product.findAll({ where: { nameProduct: { [db.Sequelize.Op.like]: 'pts_%' } }, attributes: ['id'], paranoid: false })
  const pids = [...new Set([...products, ...extra].map((p) => p.id))]
  await db.stock_history.destroy({ where: { product: pids }, force: true })
  await db.product_store_stock.destroy({ where: { product: pids }, force: true })
  await db.product_store.destroy({ where: { product: pids }, force: true })
  await db.product.destroy({ where: { id: pids }, force: true })
  await db.tenantMembership.destroy({ where: { userId: ids.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.update({ store: null }, { where: { id: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.category.destroy({ where: { id: ids.categories }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
  await db.sequelize.close()
})

test('the global SKU constraint is replaced by per-tenant + tenant-less indexes', async () => {
  const [rows] = await db.sequelize.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'product' AND indexname IN ('product_sku_key', 'uq_product_tenant_sku', 'uq_product_tenantless_sku', 'ix_product_tenant') ORDER BY 1`
  )
  expect(rows.map((r) => r.indexname)).toEqual(['ix_product_tenant', 'uq_product_tenant_sku', 'uq_product_tenantless_sku'])
})

test('two tenants import the same SKU; each gets its own product with its tenant', async () => {
  const sku = uniq('SKU').toUpperCase()
  const a = await importAs(f.ownerA, [row({ 'Nama Produk': uniq('pA'), SKU: sku })])
  expect(a.status).toBe(200)
  const b = await importAs(f.ownerB, [row({ 'Nama Produk': uniq('pB'), SKU: sku })])
  expect(b.status).toBe(200)
  expect(JSON.stringify(b.body)).not.toMatch(/sudah terdaftar|milik toko lain/)

  const rows = await db.product.findAll({ where: { sku }, order: [['id', 'ASC']] })
  expect(rows.map((p) => p.tenantId)).toEqual([f.tA.id, f.tB.id])
})

test('inside one tenant a SKU stays unique', async () => {
  const sku = uniq('DUP').toUpperCase()
  expect((await importAs(f.ownerA, [row({ 'Nama Produk': uniq('p1'), SKU: sku })])).status).toBe(200)
  const again = await importAs(f.ownerA, [row({ 'Nama Produk': uniq('p2'), SKU: sku })])
  expect(again.status).toBeGreaterThanOrEqual(400)
  expect(await db.product.count({ where: { sku } })).toBe(1)

  await expect(
    db.product.create({ nameProduct: uniq('raw'), sku, tenantId: f.tA.id, category: f.category.id })
  ).rejects.toThrow()
  await db.product.create({ nameProduct: uniq('raw'), sku, tenantId: f.tB.id, category: f.category.id })
})

test('tenant-less products keep a global SKU rule', async () => {
  const sku = uniq('TL').toUpperCase()
  await db.product.create({ nameProduct: uniq('tl1'), sku, category: f.category.id })
  await expect(db.product.create({ nameProduct: uniq('tl2'), sku, category: f.category.id })).rejects.toThrow()
})

test('the backfill sets the tenant only when every outlet agrees, and is replay-safe', async () => {
  const single = await db.product.create({ nameProduct: uniq('bf1'), category: f.category.id })
  const cross = await db.product.create({ nameProduct: uniq('bf2'), category: f.category.id })
  // Raw SQL bypasses the tenant-consistency hooks: simulates pre-PGA-02 data.
  await db.sequelize.query(
    `INSERT INTO product_store (product, store, "createdAt", "updatedAt")
     VALUES (:s, :a, NOW(), NOW()), (:c, :a, NOW(), NOW()), (:c, :b, NOW(), NOW())`,
    { replacements: { s: single.id, c: cross.id, a: f.a1.id, b: f.b1.id } }
  )
  await migration.up(db.sequelize.getQueryInterface(), db.Sequelize)
  expect((await db.product.findByPk(single.id)).tenantId).toBe(f.tA.id)
  expect((await db.product.findByPk(cross.id)).tenantId).toBeNull()
})
