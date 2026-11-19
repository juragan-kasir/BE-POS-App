process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const ExcelJS = require('exceljs')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// CRIT-4 regression: GET /export/master-data could export ALL tenants' master
// data when `store` was omitted, and `product`/`department` were exported
// unfiltered even with a store param.
//
// Required invariant: tenant users must export ONLY their own store's data.
// The tenant must come from req.storeId (authorization context) — never from
// query/body/cookie. super_admin retains explicit global export.

const bufParser = (res, cb) => {
  const chunks = []
  res.on('data', (c) => chunks.push(c))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

const mkToken = (roleType, store, id) =>
  signSessionToken(
    { id, userName: `tok_${roleType}_${id}`, roleType, store },
    JWT_SECRET
  )

// Loads the xlsx response buffer and returns { sheetName -> array of records }
// where a record is a plain object built from the header row.
async function parseWorkbook(res) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(res.body)
  const out = {}
  wb.eachSheet((sheet) => {
    const rows = []
    let header = null
    sheet.eachRow((row, rowNumber) => {
      const vals = row.values
      const cells = vals.slice(1).map((v) => (v ? String(v) : ''))
      if (rowNumber === 1) {
        header = cells
      } else if (header && !cells.every((c) => c === '')) {
        const rec = {}
        header.forEach((h, i) => {
          rec[h] = cells[i]
        })
        rows.push(rec)
      }
    })
    out[sheet.name] = rows
  })
  return out
}

let store1 = null
let store2 = null
let adminStore1Token = null
let adminStore2Token = null
let superAdminToken = null

let supplierS1 = null
let supplierS2 = null
let productS1 = null
let productS2 = null
let categoryS1 = null
let categoryS2 = null
let departmentRec = null

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({
    name: `CRIT4_STORE1_${Date.now()}`,
    status: 'active'
  }))
  store2 = await db.location.create(await withTestTenant({
    name: `CRIT4_STORE2_${Date.now()}`,
    status: 'active'
  }))


  // P1-4: central gate denies unknown caller identities; these rows give the
  // caller ids above real identities. Assertions below are unchanged.
  for (const [id, userName, roleType, userType, store] of [
    [7301, 'cr4_admin1', 'admin', 'admin', store1.id],
    [7302, 'cr4_admin2', 'admin', 'admin', store2.id],
    [7300, 'cr4_super', 'super_admin', 'admin', null]
  ]) {
    await db.user.create({
      id,
      userName,
      email: `p14-${id}-crit4@test.com`,
      roleType,
      userType,
      store,
      status: 'active',
      fullName: userName
    })
  }
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminStore1Token = await mkToken('admin', store1.id, 7301)
  adminStore2Token = await mkToken('admin', store2.id, 7302)
  superAdminToken = await mkToken('super_admin', null, 7300)

  const suffix = Date.now()

  supplierS1 = await db.supplier.create({
    name: `CR4_SUPPLIER_S1_${suffix}`,
    store: store1.id,
    status: 'active'
  })
  supplierS2 = await db.supplier.create({
    name: `CR4_SUPPLIER_S2_${suffix}`,
    store: store2.id,
    status: 'active'
  })

  categoryS1 = await db.category.create({
    name: `CR4_CAT_S1_${suffix}`,
    status: 'active'
  })
  categoryS2 = await db.category.create({
    name: `CR4_CAT_S2_${suffix}`,
    status: 'active'
  })
  await db.category_store.create({ category: categoryS1.id, store: store1.id })
  await db.category_store.create({ category: categoryS2.id, store: store2.id })

  productS1 = await db.product.create({
    nameProduct: `CR4_PROD_S1_${suffix}`,
    category: categoryS1.id,
    price: 1000,
    stock: 5,
    isAvailable: true
  })
  productS2 = await db.product.create({
    nameProduct: `CR4_PROD_S2_${suffix}`,
    category: categoryS2.id,
    price: 2000,
    stock: 6,
    isAvailable: true
  })
  await db.product_store.create({ product: productS1.id, store: store1.id })
  await db.product_store.create({ product: productS2.id, store: store2.id })

  departmentRec = await db.department.create({
    name: `CR4_DEPT_${suffix}`
  })
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [7301, 7302, 7300] }, force: true })
  await db.product_store.destroy(
    { where: { product: [productS1.id, productS2.id] }, force: true }
  )
  await db.category_store.destroy(
    { where: { category: [categoryS1.id, categoryS2.id] }, force: true }
  )
  await db.product.destroy({ where: { id: [productS1.id, productS2.id] }, force: true })
  await db.category.destroy({ where: { id: [categoryS1.id, categoryS2.id] }, force: true })
  await db.supplier.destroy({ where: { id: [supplierS1.id, supplierS2.id] }, force: true })
  await db.department.destroy({ where: { id: departmentRec.id }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
})

describe('CRIT-4 exportMaster tenant isolation', () => {
  test('Store-1 admin export without store param only contains Store-1 data', async () => {
    const res = await request(app)
      .get('/export/master-data')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .parse(bufParser)

    expect(res.status).toBe(200)
    const sheets = await parseWorkbook(res)

    const supplierSheet = sheets['Supplier'] || []
    const supplierNames = supplierSheet.map((r) => r.name)
    expect(supplierNames).toContain(supplierS1.name)
    expect(supplierNames).not.toContain(supplierS2.name)

    const productSheet = sheets['Produk'] || []
    const productNames = productSheet.map((r) => r.nameProduct)
    expect(productNames).toContain(productS1.nameProduct)
    expect(productNames).not.toContain(productS2.nameProduct)

    const categorySheet = sheets['Kategori'] || []
    const catNames = categorySheet.map((r) => r.name)
    expect(catNames).toContain(categoryS1.name)
    expect(catNames).not.toContain(categoryS2.name)
  })

  test('Store-1 admin export with store=Store-2 query cannot leak Store-2 data', async () => {
    const res = await request(app)
      .get('/export/master-data')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .parse(bufParser)
      .query({ store: store2.id })

    // Either the middleware rejects the spoof, or it still yields store-1 data
    if (res.status === 200) {
      const sheets = await parseWorkbook(res)
      const supplierNames = (sheets['Supplier'] || []).map((r) => r.name)
      expect(supplierNames).toContain(supplierS1.name)
      expect(supplierNames).not.toContain(supplierS2.name)
    } else {
      expect([400, 403]).toContain(res.status)
    }
  })

  test('Store-1 admin export with body storeId=Store-2 cannot leak Store-2 data', async () => {
    const res = await request(app)
      .get('/export/master-data')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .parse(bufParser)
      .send({ storeId: store2.id })

    if (res.status === 200) {
      const sheets = await parseWorkbook(res)
      const supplierNames = (sheets['Supplier'] || []).map((r) => r.name)
      expect(supplierNames).not.toContain(supplierS2.name)
    } else {
      expect([400, 403]).toContain(res.status)
    }
  })

  test('Store-1 admin export with cookie store=Store-2 cannot leak Store-2 data', async () => {
    const res = await request(app)
      .get('/export/master-data')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .parse(bufParser)
      .set('Cookie', `store=${store2.id}`)

    expect(res.status).toBe(200)
    const sheets = await parseWorkbook(res)
    const supplierNames = (sheets['Supplier'] || []).map((r) => r.name)
    expect(supplierNames).toContain(supplierS1.name)
    expect(supplierNames).not.toContain(supplierS2.name)
  })

  test('Store-2 admin sees only Store-2 data (symmetric)', async () => {
    const res = await request(app)
      .get('/export/master-data')
      .set('Authorization', `Bearer ${adminStore2Token}`)
      .parse(bufParser)

    expect(res.status).toBe(200)
    const sheets = await parseWorkbook(res)
    const supplierNames = (sheets['Supplier'] || []).map((r) => r.name)
    expect(supplierNames).toContain(supplierS2.name)
    expect(supplierNames).not.toContain(supplierS1.name)
  })

  test('super_admin without store param performs an explicit global export', async () => {
    const res = await request(app)
      .get('/export/master-data')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .parse(bufParser)

    expect(res.status).toBe(200)
    const sheets = await parseWorkbook(res)
    const supplierNames = (sheets['Supplier'] || []).map((r) => r.name)
    expect(supplierNames).toContain(supplierS1.name)
    expect(supplierNames).toContain(supplierS2.name)

    // global reference data (no store linkage) is present on the global export
    const deptSheet = sheets['Departemen'] || []
    const deptNames = deptSheet.map((r) => r.name)
    expect(deptNames).toContain(departmentRec.name)
  })

  test('Store-1 admin export does not silently include global reference data', async () => {
    const res = await request(app)
      .get('/export/master-data')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .parse(bufParser)

    expect(res.status).toBe(200)
    const sheets = await parseWorkbook(res)
    const deptSheet = sheets['Departemen'] || []
    const deptNames = deptSheet.map((r) => r.name)
    expect(deptNames).not.toContain(departmentRec.name)
  })
})