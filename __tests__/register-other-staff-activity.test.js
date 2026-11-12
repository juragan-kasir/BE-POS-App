process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// E2E 2026-11-11 (F-11): a store has one drawer, so the owner's own sale and
// a refund the owner approved land in the kasir's open register. The kasir
// is told who else moved money through their drawer.

const RUN = Date.now()
let store
let kasir
let owner
let token
let order
let salesReturn
let registerId

const makeUser = (role, name) =>
  db.user.create({
    userName: `otherstaff_${role}_${RUN}`,
    email: `otherstaff_${role}_${RUN}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: name
  })

beforeAll(async () => {
  store = await db.location.create({ name: `OTHERSTAFF_STORE_${RUN}`, status: 'active' })
  kasir = await makeUser('kasir', 'Sari')
  owner = await makeUser('owner', 'Budi')
  token = await signSessionToken(
    { id: kasir.id, userName: kasir.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  order = await db.order.create({
    store: store.id,
    orderNumber: `OTHERSTAFF-${RUN}`,
    subTotal: 45000,
    totalPrice: 45000,
    totalQuantity: 1,
    status: 'paid',
    paymentStatus: 'paid'
  })
  salesReturn = await db.sales_return.create({
    order: order.id,
    store: store.id,
    returnNumber: `RET-OTHERSTAFF-${RUN}`,
    status: 'approved',
    refundAmount: 16500
  })

  const openRes = await request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${token}`)
    .send({ store: store.id, openingBalance: 0 })
  registerId = openRes.body.data.id

  await db.transaction.bulkCreate([
    { order: order.id, typePayment: 'CASH', amount: 20000, cashRegisterId: registerId, createdBy: kasir.id },
    { order: order.id, typePayment: 'CASH', amount: 25000, cashRegisterId: registerId, createdBy: owner.id },
    {
      order: order.id,
      salesReturnId: salesReturn.id,
      typePayment: 'CASH',
      amount: -16500,
      cashRegisterId: registerId,
      createdBy: owner.id
    }
  ])
})

afterAll(async () => {
  await db.transaction.destroy({ where: { order: order.id }, force: true })
  await db.sales_return.destroy({ where: { id: salesReturn.id }, force: true })
  await db.order.destroy({ where: { id: order.id }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.user.destroy({ where: { id: [kasir.id, owner.id] }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

const budi = () => ({
  fullName: 'Budi',
  salesCount: 1,
  salesAmount: 25000,
  refundCount: 1,
  refundAmount: 16500
})

test('the open register and the X report name the other person and what they moved', async () => {
  const current = await request(app)
    .get('/cash-register/current')
    .query({ store: store.id })
    .set('Authorization', `Bearer ${token}`)
  expect(current.status).toBe(200)
  expect(current.body.data.otherStaff).toEqual([expect.objectContaining({ userId: owner.id, ...budi() })])

  const xReport = await request(app)
    .get('/cash-register/x-report')
    .query({ store: store.id })
    .set('Authorization', `Bearer ${token}`)
  expect(xReport.status).toBe(200)
  expect(xReport.body.data.otherStaff).toEqual([expect.objectContaining(budi())])
})

test('the Z report keeps the same list after the register is closed', async () => {
  const closeRes = await request(app)
    .put(`/cash-register/close/${registerId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ store: store.id, closingBalance: 28500 })
  expect(closeRes.status).toBe(200)
  expect(closeRes.body.data.otherStaff).toEqual([expect.objectContaining(budi())])

  const zReport = await request(app)
    .get(`/cash-register/z-report/${registerId}`)
    .query({ store: store.id })
    .set('Authorization', `Bearer ${token}`)
  expect(zReport.status).toBe(200)
  expect(zReport.body.data.otherStaff).toEqual([expect.objectContaining(budi())])
})
