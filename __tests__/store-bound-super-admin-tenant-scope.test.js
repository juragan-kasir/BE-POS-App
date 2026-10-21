process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const ExcelJS = require('exceljs')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// DR-02 "super_admin ≠ all stores ≠ all tenants": a store-bound super_admin
// (users.store set — e.g. a business owner's own account) works inside the
// tenant of its own store. "All Stores" means every outlet of THAT tenant,
// never another tenant's outlets; a global super_admin stays unrestricted,
// and a store without a tenant keeps the pre-tenant behavior.

const PREFIX = `tsc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()

const ids = { tenants: [], stores: [], users: [], suppliers: [] }
const s = {}
const t = {}
let phoneSeq = 0
const phone = () => `0811${String(Date.now()).slice(-6)}${String(++phoneSeq).padStart(2, '0')}`

const makeStore = async (key, tenantId) => {
  const row = await db.location.create({ name: unique(key), status: 'active', ...(tenantId ? { tenantId } : {}) })
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
    userType: roleType === 'user' ? 'user' : 'admin',
    status: 'active',
    store: store ?? null
  })
  ids.users.push(row.id)
  return signSessionToken({ id: row.id, roleType, store: store ?? null }, JWT_SECRET)
}

const makeSupplier = async (key, store) => {
  const row = await db.supplier.create({ name: unique(key), phone: phone(), status: 'active', store })
  ids.suppliers.push(row.id)
  return row
}

const as = (token) => ({ Authorization: `Bearer ${token}` })
const listNames = async (token, query = '') => {
  const res = await request(app).get(`/supplier?page=1&limit=100${query}`).set(as(token))
  return { res, names: (res.body.data || []).map((r) => r.name) }
}

beforeAll(async () => {
  const tenantA = await db.tenant.create({ code: unique('TA').toUpperCase(), name: unique('Tenant A') })
  const tenantB = await db.tenant.create({ code: unique('TB').toUpperCase(), name: unique('Tenant B') })
  ids.tenants.push(tenantA.id, tenantB.id)
  s.a1 = await makeStore('A1', tenantA.id)
  s.a2 = await makeStore('A2', tenantA.id)
  s.b1 = await makeStore('B1', tenantB.id)
  s.loose = await makeStore('NOTENANT', null)

  t.boundA = await makeUser('owner_a', 'super_admin', s.a1.id)
  t.boundLoose = await makeUser('owner_loose', 'super_admin', s.loose.id)
  t.global = await makeUser('global', 'super_admin', null)
  t.adminA1 = await makeUser('admin_a1', 'admin', s.a1.id)

  s.supA1 = await makeSupplier('SUP_A1', [s.a1.id])
  s.supA2 = await makeSupplier('SUP_A2', [s.a2.id])
  s.supB1 = await makeSupplier('SUP_B1', [s.b1.id])
  s.supShared = await makeSupplier('SUP_SHARED', [])
})

afterAll(async () => {
  await db.supplier.destroy({ where: { id: ids.suppliers }, force: true })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

describe('supplier list', () => {
  test('store-bound super_admin "All Stores": its tenant\'s outlets + shared, never another tenant', async () => {
    const { res, names } = await listNames(t.boundA, '&store=')
    expect(res.status).toBe(200)
    expect(names).toEqual(expect.arrayContaining([s.supA1.name, s.supA2.name, s.supShared.name]))
    expect(names).not.toContain(s.supB1.name)
  })

  test('store-bound super_admin: an outlet of its tenant narrows; another tenant\'s outlet is refused', async () => {
    const own = await listNames(t.boundA, `&store=${s.a2.id}`)
    expect(own.names).toEqual(expect.arrayContaining([s.supA2.name, s.supShared.name]))
    expect(own.names).not.toContain(s.supA1.name)
    const foreign = await request(app).get(`/supplier?store=${s.b1.id}`).set(as(t.boundA))
    expect(foreign.status).toBe(403)
    expect(foreign.body.code).toBe('FOREIGN_STORE')
  })

  test('global super_admin "All Stores" stays unrestricted', async () => {
    const { names } = await listNames(t.global, '&store=')
    expect(names).toEqual(expect.arrayContaining([s.supA1.name, s.supA2.name, s.supB1.name, s.supShared.name]))
  })

  test('a store without a tenant keeps the pre-tenant behavior', async () => {
    const { names } = await listNames(t.boundLoose, '&store=')
    expect(names).toEqual(expect.arrayContaining([s.supA1.name, s.supB1.name]))
  })

  test('outlet admin: own outlet + shared only', async () => {
    const { names } = await listNames(t.adminA1)
    expect(names).toEqual(expect.arrayContaining([s.supA1.name, s.supShared.name]))
    expect(names).not.toContain(s.supA2.name)
    expect(names).not.toContain(s.supB1.name)
  })
})

describe('supplier records', () => {
  test('another tenant\'s supplier answers 404 to a store-bound super_admin', async () => {
    expect((await request(app).get(`/supplier/${s.supB1.id}`).set(as(t.boundA))).status).toBe(404)
    expect((await request(app).get(`/supplier/detail/${s.supB1.id}`).set(as(t.boundA))).status).toBe(404)
    expect((await request(app).get(`/supplier/${s.supA2.id}`).set(as(t.boundA))).status).toBe(200)
    expect((await request(app).put(`/supplier/${s.supB1.id}`).set(as(t.boundA)).send({ name: unique('X') })).status).toBe(404)
    expect((await request(app).delete(`/supplier/${s.supB1.id}`).set(as(t.boundA))).status).toBe(404)
    expect(await db.supplier.findByPk(s.supB1.id)).not.toBeNull()
  })

  test('"all stores" on create means every outlet of the creator\'s tenant, not a shared supplier', async () => {
    const res = await request(app)
      .post('/supplier')
      .set(as(t.boundA))
      .send({ name: unique('NEW_ALL'), phone: phone(), status: 'active', store: [] })
    expect(res.status).toBe(201)
    ids.suppliers.push(res.body.data.id)
    const stored = (await db.supplier.findByPk(res.body.data.id)).store.map(Number).sort((x, y) => x - y)
    expect(stored).toEqual([s.a1.id, s.a2.id].sort((x, y) => x - y))
    const other = await listNames(t.global, `&store=${s.b1.id}`)
    expect(other.names).not.toContain(res.body.data.name)
  })

  test('creating for another tenant\'s outlet is refused', async () => {
    const res = await request(app)
      .post('/supplier')
      .set(as(t.boundA))
      .send({ name: unique('NEW_FOREIGN'), phone: phone(), status: 'active', store: [s.b1.id] })
    expect(res.status).toBe(403)
  })

  test('the reported flow: created for one outlet, visible under that outlet AND under "All Stores"', async () => {
    const res = await request(app)
      .post('/supplier')
      .set(as(t.boundA))
      .send({ name: unique('NEW_A2'), phone: phone(), status: 'active', store: [s.a2.id] })
    expect(res.status).toBe(201)
    ids.suppliers.push(res.body.data.id)
    expect((await listNames(t.boundA, '&store=')).names).toContain(res.body.data.name)
    expect((await listNames(t.boundA, `&store=${s.a2.id}`)).names).toContain(res.body.data.name)
  })

  test('outlet admin can update its own outlet\'s supplier (was a 500)', async () => {
    const res = await request(app).put(`/supplier/${s.supA1.id}`).set(as(t.adminA1)).send({ address: 'Jl. Baru' })
    expect(res.status).toBe(200)
  })

  test('outlet admin export contains only its own outlet + shared suppliers', async () => {
    const res = await request(app)
      .get('/supplier/download')
      .set(as(t.adminA1))
      .buffer(true)
      .parse((r, cb) => {
        const chunks = []
        r.on('data', (c) => chunks.push(c))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(res.body)
    const names = []
    workbook.worksheets[0].eachRow((row, i) => {
      if (i > 1) names.push(row.getCell(2).value)
    })
    expect(names).toEqual(expect.arrayContaining([s.supA1.name, s.supShared.name]))
    expect(names).not.toContain(s.supA2.name)
    expect(names).not.toContain(s.supB1.name)
  })
})

describe('store pickers (locations)', () => {
  test('a store-bound super_admin lists and reads only its tenant\'s outlets', async () => {
    const res = await request(app).get('/location/get-location-all?page=1&limit=100').set(as(t.boundA))
    expect(res.status).toBe(200)
    const listed = JSON.stringify(res.body)
    expect(listed).toContain(s.a1.name)
    expect(listed).toContain(s.a2.name)
    expect(listed).not.toContain(s.b1.name)
    expect((await request(app).get(`/location/get-location-detail/loc-${s.b1.id}`).set(as(t.boundA))).status).toBe(404)
    expect((await request(app).get(`/location/get-location-detail/loc-${s.a2.id}`).set(as(t.boundA))).status).toBe(200)
  })

  test('a global super_admin still lists every outlet', async () => {
    const res = await request(app).get('/location/get-location-all?page=1&limit=1000').set(as(t.global))
    const listed = JSON.stringify(res.body)
    expect(listed).toContain(s.a1.name)
    expect(listed).toContain(s.b1.name)
  })
})
