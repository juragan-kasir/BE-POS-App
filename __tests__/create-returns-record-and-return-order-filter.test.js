process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

// The FE success notice opens the record it just created ("Lihat Detail"),
// so a create must return it; and the order detail page lists the sales
// returns made against one order.

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const stamp = Date.now()

let location = null
let adminUser = null
let adminToken = null
const created = { category: [], department: [], position: [] }
let orderA = null
let orderB = null

beforeAll(async () => {
  location = await db.location.create({
    name: `CRID_STORE_${stamp}`,
    status: 'active'
  })
  adminUser = await db.user.create({
    userName: `crid_admin_${stamp}`,
    email: `crid_admin_${stamp}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    {
      id: adminUser.id,
      userName: adminUser.userName,
      roleType: 'admin',
      store: location.id
    },
    JWT_SECRET
  )
  orderA = await db.order.create({
    orderNumber: `CRID-A-${stamp}`,
    store: location.id
  })
  orderB = await db.order.create({
    orderNumber: `CRID-B-${stamp}`,
    store: location.id
  })
  const makeReturn = (order, n) =>
    db.sales_return.create({
      order: order.id,
      store: location.id,
      returnNumber: `SR-CRID-${stamp}-${n}`,
      status: 'pending',
      reason: 'Test',
      refundAmount: 1000,
      refundMethod: 'cash'
    })
  await makeReturn(orderA, 1)
  await makeReturn(orderA, 2)
  await makeReturn(orderB, 3)
})

afterAll(async () => {
  await db.sales_return.destroy({ where: { store: location?.id }, force: true })
  await db.order.destroy({ where: { store: location?.id }, force: true })
  await db.position.destroy({ where: { id: created.position }, force: true })
  await db.department.destroy({
    where: { id: created.department },
    force: true
  })
  if (db.category_store) {
    await db.category_store.destroy({
      where: { category: created.category },
      force: true
    })
  }
  await db.category.destroy({ where: { id: created.category }, force: true })
  await db.user.destroy({ where: { id: adminUser?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
  await db.sequelize.close()
})

describe('create returns the new record', () => {
  test('category', async () => {
    const name = `CRID Category ${stamp}`
    const res = await request(app)
      .post('/category/add-new-category')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name })
    expect(res.status).toBe(200)
    const row = await db.category.findOne({ where: { name } })
    created.category.push(row.id)
    expect(res.body.data).toMatchObject({ id: row.id, name })
  })

  test('department', async () => {
    const name = `CRID Department ${stamp}`
    const res = await request(app)
      .post('/department/add-new-department')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name })
    expect(res.status).toBe(200)
    const row = await db.department.findOne({ where: { name } })
    created.department.push(row.id)
    expect(res.body.data).toMatchObject({ id: row.id, name })
  })

  test('position', async () => {
    const name = `CRID Position ${stamp}`
    const res = await request(app)
      .post('/position/add-new-position')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, departmentId: created.department[0] })
    expect(res.status).toBe(200)
    const row = await db.position.findOne({ where: { name } })
    created.position.push(row.id)
    expect(res.body.data).toMatchObject({ id: row.id, name })
  })
})

describe('GET /sales-return/get-all?orderId=', () => {
  const list = (query) =>
    request(app)
      .get(`/sales-return/get-all${query}`)
      .set('Authorization', `Bearer ${adminToken}`)

  test('lists only the returns of that order', async () => {
    const res = await list(`?orderId=${orderA.id}&limit=50`)
    expect(res.status).toBe(200)
    const rows = res.body.data
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.order === orderA.id)).toBe(true)
  })

  test('without orderId the list is unchanged', async () => {
    const res = await list('?limit=50')
    expect(res.status).toBe(200)
    expect(res.body.data.map((r) => r.order).sort()).toEqual(
      [orderA.id, orderA.id, orderB.id].sort()
    )
  })

  test('a non-numeric orderId is a 400', async () => {
    const res = await list('?orderId=abc')
    expect(res.status).toBe(400)
  })
})
