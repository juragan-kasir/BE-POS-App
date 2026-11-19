process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 2 HIGH-9 regression: purchaseReturn trusted the client cookie
// (req.cookies.store) and fell back to an all-stores read when no store was
// present or claimed — a store A admin could list store B returns, read a
// foreign store's returns by PO id, and even create a return against a
// foreign store's purchase order (deducting stock) by crossing the cookie
// boundary. Every read/mutation must now derive from the pinned req.storeId
// and create must verify the purchase order belongs to the caller's store.

let store1 = null
let store2 = null
let category = null
let product = null
let po1 = null
let po2 = null
let ret1 = null
let ret2 = null
let userAdmin1 = null
let userSuper = null
let admin1Token = null
let superToken = null
let createdSuperRet = null

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({ name: 'HIGH9_STORE_A', status: 'active' }))
  store2 = await db.location.create(await withTestTenant({ name: 'HIGH9_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'HIGH9_CAT', status: 'active' })
  product = await db.product.create({
    nameProduct: 'HIGH9_Product',
    category: category.id,
    price: 1000,
    stock: 20
  })

  const suffix = Date.now()
  userAdmin1 = await db.user.create({
    id: 9801,
    userName: `high9_admin_a_${suffix}`,
    roleType: 'admin',
    store: store1.id,
    password: 'x'
  })
  userSuper = await db.user.create({
    id: 9800,
    userName: `high9_super_${suffix}`,
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

  po1 = await db.purchase_order.create({
    store: store1.id,
    orderNumber: `HIGH9-PO-${Date.now()}-A`,
    status: 'received',
    totalAmount: 5000,
    finalAmount: 5000
  })
  po2 = await db.purchase_order.create({
    store: store2.id,
    orderNumber: `HIGH9-PO-${Date.now()}-B`,
    status: 'received',
    totalAmount: 5000,
    finalAmount: 5000
  })
  await db.purchase_order_item.bulkCreate([
    { purchaseOrder: po1.id, product: product.id, quantity: 5, price: 1000, receivedQuantity: 5 },
    { purchaseOrder: po2.id, product: product.id, quantity: 5, price: 1000, receivedQuantity: 5 }
  ])

  ret1 = await db.purchase_return.create({
    purchaseOrder: po1.id,
    store: store1.id,
    returnNumber: `HIGH9-RET-${Date.now()}-A`,
    status: 'pending'
  })
  ret2 = await db.purchase_return.create({
    purchaseOrder: po2.id,
    store: store2.id,
    returnNumber: `HIGH9-RET-${Date.now()}-B`,
    status: 'pending'
  })
})

afterAll(async () => {
  const poIds = [po1?.id, po2?.id].filter(Boolean)
  if (poIds.length > 0) {
    const stray = await db.purchase_return.findAll({
      where: { purchaseOrder: { [db.Sequelize.Op.in]: poIds } },
      attributes: ['id']
    })
    if (stray.length > 0) {
      const strayIds = stray.map((r) => r.id)
      await db.purchase_return_item.destroy({ where: { purchaseReturn: { [db.Sequelize.Op.in]: strayIds } }, force: true })
      await db.purchase_return.destroy({ where: { id: { [db.Sequelize.Op.in]: strayIds } }, force: true })
    }
  }
  await db.stock_history.destroy({ where: { product: product?.id, referenceType: 'purchase_return' }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.update({ stock: 20 }, { where: { id: product?.id } })
  await db.purchase_order_item.destroy({ where: { purchaseOrder: poIds }, force: true })
  await db.purchase_order.destroy({ where: { id: poIds }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  if (userAdmin1?.id) {
    await db.auditLog.destroy({ where: { userId: userAdmin1.id }, force: true, __auditMaintenance: true })
    await db.user.destroy({ where: { id: userAdmin1.id }, force: true })
  }
  if (userSuper?.id) {
    await db.auditLog.destroy({ where: { userId: userSuper.id }, force: true, __auditMaintenance: true })
    await db.user.destroy({ where: { id: userSuper.id }, force: true })
  }
  await db.location.destroy({ where: { id: [store1?.id, store2?.id].filter(Boolean) }, force: true })
})

const retNumbers = (res) =>
  (res.body.data || []).map((r) => r.returnNumber)

describe('HIGH-9 purchase return tenant scoping', () => {
  test('store1 admin listing returns WITHOUT store param sees only store1', async () => {
    const res = await request(app)
      .get('/purchase-return/get-all')
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const nums = retNumbers(res)
    expect(nums).toContain(ret1.returnNumber)
    expect(nums).not.toContain(ret2.returnNumber)
  })

  test('store1 admin listing returns with a store2 cookie still sees only store1', async () => {
    const res = await request(app)
      .get('/purchase-return/get-all')
      .set('Cookie', `store=${store2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const nums = retNumbers(res)
    expect(nums).toContain(ret1.returnNumber)
    expect(nums).not.toContain(ret2.returnNumber)
  })

  test('store1 admin with a foreign store query param gets 403', async () => {
    const res = await request(app)
      .get('/purchase-return/get-all')
      .query({ store: store2.id })
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(403)
  })

  test('store1 admin cannot read store2 return by id', async () => {
    const res = await request(app)
      .get(`/purchase-return/get-by-id/${ret2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(404)
  })

  test('store1 admin can read own return by id', async () => {
    const res = await request(app)
      .get(`/purchase-return/get-by-id/${ret1.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
  })

  test('store1 admin querying returns BY store2 PO id sees nothing', async () => {
    const res = await request(app)
      .get(`/purchase-return/by-po/${po2.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(retNumbers(res)).not.toContain(ret2.returnNumber)
  })

  test('store1 admin querying returns BY own PO id sees own returns', async () => {
    const res = await request(app)
      .get(`/purchase-return/by-po/${po1.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    expect(retNumbers(res)).toContain(ret1.returnNumber)
  })

  test('store1 admin cannot create a return against a store2 PO', async () => {
    const before = await db.purchase_return.count({
      where: { purchaseOrder: po2.id, store: store1.id }
    })

    const res = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        purchaseOrder: po2.id,
        items: [{ productId: product.id, qty: 1 }]
      })

    expect(res.status).toBe(403)

    const after = await db.purchase_return.count({
      where: { purchaseOrder: po2.id, store: store1.id }
    })
    expect(after).toBe(before)
  })

  test('store1 admin can create a return against their own PO (mutation path preserved)', async () => {
    const res = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        purchaseOrder: po1.id,
        reason: 'HIGH9 regression fixture',
        items: [{ productId: product.id, qty: 1 }]
      })

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ store: store1.id, purchaseOrder: po1.id })
    await db.purchase_return_item.destroy({ where: { purchaseReturn: res.body.data.id }, force: true })
    await db.purchase_return.destroy({ where: { id: res.body.data.id }, force: true })
    await db.stock_history.destroy({ where: { product: product.id, referenceType: 'purchase_return' }, force: true })
    await db.product.update({ stock: db.sequelize.literal('stock + 1') }, { where: { id: product.id } })
  })

  test('super_admin listing returns still sees every store (intentional)', async () => {
    const res = await request(app)
      .get('/purchase-return/get-all')
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    const nums = retNumbers(res)
    expect(nums).toContain(ret1.returnNumber)
    expect(nums).toContain(ret2.returnNumber)
  })

  test('super_admin can still read a store return by id', async () => {
    const res = await request(app)
      .get(`/purchase-return/get-by-id/${ret2.id}`)
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
  })

  test('super_admin can still create against a store PO', async () => {
    const res = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        purchaseOrder: po1.id,
        items: [{ productId: product.id, qty: 1 }]
      })

    expect(res.status).toBe(201)
    createdSuperRet = res.body.data
  })
})