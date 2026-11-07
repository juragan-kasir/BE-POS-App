'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-23 (harness 46-catalog-import, 2026-11-08): the Excel catalog import
// - left every imported product at outlet stock 0 (no product_store_stock
//   row; DR-14 reads a missing row as 0);
// - let a store-bound owner import into ANOTHER tenant's outlet by naming it,
//   and turned "Semua Toko" into an unassigned product sold by every
//   merchant;
// - overwrote product.stock on an update, leaving it unequal to the outlets.
const request = require('supertest')
const ExcelJS = require('exceljs')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) =>
  `p23_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const HEADERS = [
  'No.',
  'Nama Produk',
  'SKU',
  'Barcode',
  'Brand/Merek',
  'Kategori',
  'Tipe Produk',
  'Deskripsi',
  'Store',
  'Satuan',
  'Base Satuan',
  'Faktor Konversi',
  'Supplier',
  'Pajak',
  'Harga',
  'Harga Beli',
  'Stok',
  'Min Stok',
  'Point',
  'Point Redeem',
  'Status',
  'Tersedia',
  'Opsi',
  'Daftar Opsi'
]

const ids = { tenants: [], stores: [], users: [], categories: [] }
let a1
let a2
let b1
let category
let ownerToken

const sheet = async (rows) => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Produk')
  ws.addRow(HEADERS)
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''))
  return Buffer.from(await wb.xlsx.writeBuffer())
}
const row = (o) => ({
  Kategori: category.name,
  'Tipe Produk': 'barang',
  Satuan: 'pcs',
  'Base Satuan': 'pcs',
  'Faktor Konversi': 1,
  Harga: 1000,
  Status: 'Aktif',
  Tersedia: 'Ya',
  Opsi: 'Tidak',
  ...o
})
const importSheet = async (rows) =>
  request(app)
    .post(`/product/import?store=${a1.id}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .attach('file', await sheet(rows), 'produk.xlsx')
const bySku = (sku) => db.product.findOne({ where: { sku } })
const outlets = async (productId) =>
  (
    await db.product_store_stock.findAll({
      where: { product: productId },
      order: [['store', 'ASC']]
    })
  ).map((r) => [Number(r.store), Number(r.stock)])

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
  a1 = await db.location.create({
    name: uniq('A1'),
    status: 'active',
    tenantId: tA.id
  })
  a2 = await db.location.create({
    name: uniq('A2'),
    status: 'active',
    tenantId: tA.id
  })
  b1 = await db.location.create({
    name: uniq('B1'),
    status: 'active',
    tenantId: tB.id
  })
  ids.stores.push(a1.id, a2.id, b1.id)
  category = await db.category.create({ name: uniq('CAT') })
  ids.categories.push(category.id)
  const owner = await db.user.create({
    userName: uniq('owner'),
    email: `${uniq('owner')}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active',
    store: a1.id
  })
  ids.users.push(owner.id)
  await db.tenantMembership.create({
    userId: owner.id,
    tenantId: tA.id,
    role: 'tenant_admin',
    status: 'ACTIVE'
  })
  ownerToken = await signSessionToken(
    {
      id: owner.id,
      userName: owner.userName,
      roleType: 'super_admin',
      store: a1.id
    },
    JWT_SECRET
  )
})

afterAll(async () => {
  const products = await db.product.findAll({
    where: { sku: { [db.Sequelize.Op.like]: 'p23_%' } },
    paranoid: false
  })
  const pids = products.map((p) => p.id)
  await db.stock_history.destroy({ where: { product: pids }, force: true })
  await db.product_store_stock.destroy({
    where: { product: pids },
    force: true
  })
  await db.product_store.destroy({ where: { product: pids }, force: true })
  await db.product.destroy({ where: { id: pids }, force: true })
  await db.category.destroy({ where: { id: ids.categories }, force: true })
  await db.tenantMembership.destroy({
    where: { userId: ids.users },
    force: true
  })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

describe('PGA-23: product Excel import', () => {
  test("the opening stock lands in the named outlet's stock row", async () => {
    const sku = uniq('own')
    const res = await importSheet([
      row({ 'Nama Produk': sku, SKU: sku, Store: a1.name, Stok: 12 })
    ])
    expect(res.status).toBe(200)
    const p = await bySku(sku)
    expect(await outlets(p.id)).toEqual([[a1.id, 12]])
  })

  test("a row naming another tenant's outlet is refused and lands nowhere", async () => {
    const sku = uniq('foreign')
    const res = await importSheet([
      row({ 'Nama Produk': sku, SKU: sku, Store: b1.name, Stok: 5 })
    ])
    expect(res.status).toBeGreaterThanOrEqual(400)
    const p = await bySku(sku)
    if (p)
      expect(
        await db.product_store.count({ where: { product: p.id, store: b1.id } })
      ).toBe(0)
  })

  test('"Semua Toko" means every outlet of the caller, with the stock split between them', async () => {
    const sku = uniq('all')
    const res = await importSheet([
      row({ 'Nama Produk': sku, SKU: sku, Store: 'Semua Toko', Stok: 9 })
    ])
    expect(res.status).toBe(200)
    const p = await bySku(sku)
    const assigned = (
      await db.product_store.findAll({ where: { product: p.id } })
    )
      .map((r) => Number(r.store))
      .sort((x, y) => x - y)
    expect(assigned).toEqual([a1.id, a2.id].sort((x, y) => x - y))
    const rows = await outlets(p.id)
    expect(rows.reduce((s, [, n]) => s + n, 0)).toBe(9)
    expect(rows.map(([st]) => st)).not.toContain(b1.id)
  })

  test('an import update never rewrites stock', async () => {
    const sku = uniq('upd')
    await importSheet([
      row({ 'Nama Produk': sku, SKU: sku, Store: a1.name, Stok: 7 })
    ])
    const p = await bySku(sku)
    const res = await importSheet([
      row({
        'No.': p.id,
        'Nama Produk': `${sku} RENAMED`,
        SKU: sku,
        Store: a1.name,
        Stok: 999
      })
    ])
    expect(res.status).toBe(200)
    const after = await db.product.findByPk(p.id)
    expect(after.nameProduct).toBe(`${sku} RENAMED`)
    expect(Number(after.stock)).toBe(Number(p.stock))
    expect(await outlets(p.id)).toEqual([[a1.id, 7]])
  })
})
