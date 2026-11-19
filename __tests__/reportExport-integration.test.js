process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
let token

let locId = null
let orderId = null

beforeAll(async () => {
  const loc = await db.location.create(await withTestTenant({
    store: 1,
    name: 'Bisa Nota Integ',
    address: 'Jl. Integrasi No. 1',
    city: 'Bandung',
    province: 'Jawa Barat',
    postalCode: '40111',
    phoneNumber: '08123456789',
    email: 'integ@bisa.id',
    status: 'active',
    mainBranch: true
  }))
  locId = loc.id

  // P1-4: central gate denies unknown caller identities; this row satisfies
  // the identity invariant. The JWT and all assertions are unchanged.
  await db.user.create({
    id: 9999,
    userName: 'superadmin_integ',
    email: 'p14-9999-reportexport-integration@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'superadmin_integ'
  })

  const order = await db.order.create({
    orderNumber: `INTEG-${Date.now()}`,
    store: locId,
    status: 'paid',
    paymentStatus: 'paid',
    totalPrice: 150000,
    totalQuantity: 2,
    totalCovers: 2,
    shiftId: 0
  })
  orderId = order.id
})

// AUTH-1 P2: tokens bound to real sessions, minted once the users exist.
beforeAll(async () => {
  token = await signSessionToken({ id: 9999, userName: 'superadmin_integ', roleType: 'super_admin' }, JWT_SECRET)
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [9999] }, force: true })
  if (orderId) await db.order.destroy({ where: { id: orderId }, force: true })
  if (locId) await db.location.destroy({ where: { id: locId }, force: true })
})

describe('report export integration (live DB)', () => {
  test('daily export csv returns 200 with csv content', async () => {
    const res = await request(app)
      .get('/report/export/daily?format=csv&startDate=2020-01-01&endDate=2030-12-31')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('laporan-harian.csv')
    expect(res.text).toContain('Tanggal')
  })

  test('daily export excel returns 200 with xlsx content', async () => {
    const res = await request(app)
      .get('/report/export/daily?format=excel&startDate=2020-01-01&endDate=2030-12-31')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('spreadsheetml')
    expect(res.headers['content-disposition']).toContain('xlsx')
    expect(res.text.length).toBeGreaterThan(100)
  })

  test('daily export pdf returns 200 with pdf content', async () => {
    const res = await request(app)
      .get('/report/export/daily?format=pdf&startDate=2020-01-01&endDate=2030-12-31')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
  })

  test('unknown key returns 404', async () => {
    const res = await request(app)
      .get('/report/export/bogus?format=csv')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  test('unsupported format returns 400', async () => {
    const res = await request(app)
      .get('/report/export/daily?format=docx')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
  })
})