process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// N-4 regression: stockOpname.exportSelected queried by raw ids with no tenant
// filter, so a store A admin could export another store's stock opname records
// by supplying their ids. The export must now scope the query to the caller's
// store via scalarStoreScope.

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const ExcelJS = require('exceljs')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store1 = null
let store2 = null
let userAdmin1 = null
let userSuper = null
let admin1Token = null
let superToken = null
let op1 = null
let op2 = null

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({ name: 'N4_STORE_A', status: 'active' }))
  store2 = await db.location.create(await withTestTenant({ name: 'N4_STORE_B', status: 'active' }))
  const suffix = Date.now()
  userAdmin1 = await db.user.create({
    id: 9401,
    userName: `n4_admin_a_${suffix}`,
    roleType: 'admin',
    store: store1.id,
    password: 'x'
  })
  userSuper = await db.user.create({
    id: 9400,
    userName: `n4_super_${suffix}`,
    roleType: 'super_admin',
    password: 'x'
  })
  admin1Token = await signSessionToken(
    { id: userAdmin1.id, userName: userAdmin1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: userSuper.id, userName: userSuper.userName, roleType: 'super_admin' },
    JWT_SECRET
  )

  op1 = await db.stockOpname.create({
    store: store1.id,
    opnameNumber: `N4-OP-${suffix}-STORE_A_ONLY`,
    date: new Date(),
    status: 'completed'
  })
  op2 = await db.stockOpname.create({
    store: store2.id,
    opnameNumber: `N4-OP-${suffix}-STORE_B_SECRET`,
    date: new Date(),
    status: 'completed'
  })
})

afterAll(async () => {
  await db.stockOpnameItem.destroy({ where: { stockOpname: [op1?.id, op2?.id].filter(Boolean) }, force: true })
  await db.stockOpname.destroy({ where: { id: [op1?.id, op2?.id].filter(Boolean) }, force: true })
  await db.auditLog.destroy({ where: { userId: [userAdmin1?.id, userSuper?.id].filter(Boolean) }, force: true, __auditMaintenance: true })
  await db.user.destroy({ where: { id: [userAdmin1?.id, userSuper?.id].filter(Boolean) }, force: true })
  await db.location.destroy({ where: { id: [store1?.id, store2?.id].filter(Boolean) }, force: true })
})

const exportSelected = (token, ids) =>
  request(app)
    .post('/stock-opname/export-selected')
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => cb(null, Buffer.concat(chunks)))
    })
    .send({ ids })

// The export returns an xlsx zip binary captured as a Buffer in res.body (via
// the custom binary parser above). Unpack it with excelJS so we can assert on
// actual exported cell content.
const content = async (res) => {
  if (
    res.headers['content-type'] &&
    res.headers['content-type'].includes('spreadsheet')
  ) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.isBuffer(res.body) ? res.body : Buffer.from(''))
    const vals = []
    wb.worksheets.forEach((ws) =>
      ws.eachRow((row) => row.eachCell((c) => vals.push(String(c.value || ''))))
    )
    return vals.join(' ')
  }
  return JSON.stringify(res.body || {})
}

describe('N-4 stock opname export tenant isolation', () => {
  test('store A admin cannot export store B opname by id', async () => {
    const res = await exportSelected(admin1Token, [op2.id])
    expect(await content(res)).not.toContain('STORE_B_SECRET')
  })

  test('mixed store A + store B ids cannot leak store B rows', async () => {
    const res = await exportSelected(admin1Token, [op1.id, op2.id])
    expect(await content(res)).toContain('STORE_A_ONLY')
    expect(await content(res)).not.toContain('STORE_B_SECRET')
  })

  test('store A admin can still export their own opname', async () => {
    const res = await exportSelected(admin1Token, [op1.id])
    expect(await content(res)).toContain('STORE_A_ONLY')
  })

  test('rejected export does not mutate DB state', async () => {
    const before = await db.stockOpname.findByPk(op2.id)
    await exportSelected(admin1Token, [op2.id])
    const after = await db.stockOpname.findByPk(op2.id)
    expect(after.opnameNumber).toBe(before.opnameNumber)
  })

  test('super_admin can still export store B opname (intentional)', async () => {
    const res = await exportSelected(superToken, [op2.id])
    expect(await content(res)).toContain('STORE_B_SECRET')
  })
})
