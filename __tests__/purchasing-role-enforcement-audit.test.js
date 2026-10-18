process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 9 — BE granular permission enforcement audit.
//
// Finding: every mutating (POST/PUT/PATCH/DELETE) route across the
// Bahan Baku & Pembelian ecosystem (Supplier, Supplier Category,
// Ingredient, Ingredient Category, Purchase Order, Goods Request,
// Goods Receipt, Purchase Return, Purchase Payment) already requires
// requireRole('super_admin', 'admin') (or narrower). Read endpoints are
// uniformly open to any authenticated actor across the whole app — a
// consistent, pre-existing pattern, not unique to this ecosystem.
//
// Separately: at the time of Batch 9, role.accessMenu (per-role granular
// action grants) was never read by any backend middleware/controller — it was
// returned at login purely for FE menu/button rendering. DR-24 C-02 has since
// introduced the deliberate server-side enforcement (`requireMenuAction`,
// applied to the reference table routes; rollout tracked centrally in
// api/menuRouteMap.js). This file still locks in the already-correct coarse
// role-based enforcement as regression evidence.

let store = null
let category = null
let supplierCategory = null
let supplier = null
let ingredient = null
let adminUser = null
let kasirUser = null
let adminToken = null
let kasirToken = null
let tagCounter = 0

const nextTag = () => {
  tagCounter += 1
  return `PERM_AUDIT_${Date.now()}_${tagCounter}`
}

beforeAll(async () => {
  store = await db.location.create({ name: 'PERM_AUDIT_STORE', status: 'active' })
  category = await db.category.create({ name: 'PERM_AUDIT_CATEGORY' })
  supplierCategory = await db.supplier_category.create({
    name: nextTag(),
    status: 'active'
  })
  supplier = await db.supplier.create({
    name: nextTag(),
    store: [store.id],
    categoryId: supplierCategory.id,
    status: 'active'
  })
  ingredient = await db.ingredient.create({
    store: store.id,
    name: nextTag(),
    stock: 100,
    minStock: 0,
    unit: 'g',
    baseUnit: 'g',
    conversionFactor: 1,
    costPrice: 5000,
    status: 'active'
  })

  adminUser = await db.user.create({
    userName: 'admin_perm_audit',
    email: 'admin_perm_audit@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  kasirUser = await db.user.create({
    userName: 'kasir_perm_audit',
    email: 'kasir_perm_audit@test.com',
    roleType: 'kasir',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })

  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  kasirToken = await signSessionToken(
    { id: kasirUser.id, userName: kasirUser.userName, roleType: 'kasir', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  const ownReceipts = await db.goodsReceipt.findAll({ where: { store: store.id }, attributes: ['id'] })
  const ownReceiptIds = ownReceipts.map((r) => r.id)
  await db.goodsReceiptItem.destroy({ where: { goodsReceipt: ownReceiptIds }, force: true })
  await db.goodsReceipt.destroy({ where: { store: store.id }, force: true })
  const ownPOs = await db.purchase_order.findAll({ where: { store: store.id }, attributes: ['id'] })
  const ownPOIds = ownPOs.map((po) => po.id)
  await db.purchase_order_item.destroy({ where: { purchaseOrder: ownPOIds }, force: true })
  await db.purchase_order.destroy({ where: { store: store.id }, force: true })
  await db.ingredient.destroy({ where: { store: store.id }, force: true })
  await db.supplier.destroy({ where: { id: supplier?.id }, force: true })
  await db.supplier_category.destroy({ where: { id: supplierCategory?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: [adminUser?.id, kasirUser?.id] }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('Purchasing/inventory ecosystem — mutating endpoints reject non-admin roles', () => {
  let createdPOId = null
  let createdPOItemId = null

  test('POST /purchase-order/create — kasir is rejected (403)', async () => {
    const res = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({
        store: store.id,
        status: 'ordered',
        items: [{ ingredient: ingredient.id, ingredientName: ingredient.name, quantity: 10, price: 5000 }]
      })

    expect(res.status).toBe(403)
  })

  test('POST /purchase-order/create — admin succeeds (201)', async () => {
    const res = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        status: 'ordered',
        items: [{ ingredient: ingredient.id, ingredientName: ingredient.name, quantity: 10, price: 5000 }]
      })

    expect(res.status).toBe(201)
    createdPOId = res.body.data.id
    createdPOItemId = res.body.data.items[0].id
  })

  test('POST /goods-receipt/create — kasir is rejected (403)', async () => {
    const res = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({
        store: store.id,
        purchaseOrderId: createdPOId,
        status: 'completed',
        items: [
          {
            purchaseOrderItem: createdPOItemId,
            ingredient: ingredient.id,
            ingredientName: ingredient.name,
            qtyReceived: 10,
            price: 5000,
            costPrice: 5000
          }
        ]
      })

    expect(res.status).toBe(403)
  })

  test('POST /goods-receipt/create — admin succeeds (201)', async () => {
    const res = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        purchaseOrderId: createdPOId,
        status: 'completed',
        items: [
          {
            purchaseOrderItem: createdPOItemId,
            ingredient: ingredient.id,
            ingredientName: ingredient.name,
            qtyReceived: 10,
            price: 5000,
            costPrice: 5000
          }
        ]
      })

    expect(res.status).toBe(201)
  })

  test('POST /supplier — kasir is rejected (403)', async () => {
    const res = await request(app)
      .post('/supplier')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ name: nextTag(), status: 'active' })

    expect(res.status).toBe(403)
  })

  test('POST /ingredient/add — kasir is rejected (403)', async () => {
    const res = await request(app)
      .post('/ingredient/add')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ store: store.id, name: nextTag(), unit: 'g', baseUnit: 'g' })

    expect(res.status).toBe(403)
  })

  test('POST /purchase-payment/create — kasir is rejected (403)', async () => {
    const res = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ purchaseOrder: createdPOId, amount: 1000, paymentMethod: 'cash' })

    expect(res.status).toBe(403)
  })

  test('DELETE /purchase-order/delete/:id — kasir is rejected (403)', async () => {
    const res = await request(app)
      .delete(`/purchase-order/delete/${createdPOId}`)
      .set('Authorization', `Bearer ${kasirToken}`)

    expect(res.status).toBe(403)
  })

  test('an unauthenticated request (no token) is rejected (401), not silently allowed', async () => {
    const res = await request(app).post('/purchase-order/create').send({
      store: store.id,
      status: 'ordered',
      items: [{ ingredient: ingredient.id, ingredientName: ingredient.name, quantity: 10, price: 5000 }]
    })

    expect(res.status).toBe(401)
  })
})
