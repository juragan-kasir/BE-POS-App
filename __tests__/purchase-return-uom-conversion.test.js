process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 13 — UOM / unit conversion audit.
//
// Goods Receipt correctly converts a purchase-unit quantity to the base
// stock unit before mutating stock (`qtyStock = qtyReceived * conversionToBase`,
// api/controller/goodsReceipt.js). Purchase Return's create() deducts stock
// using the return item's raw `qty` with NO conversion applied at all
// (api/controller/purchaseReturn.js, both the product and ingredient
// branches), even though it validates that same `qty` against the PO
// item's `receivedQuantity` (itself tracked in purchase-unit terms) — so
// the return is unambiguously meant to be authored in purchase-unit terms,
// exactly like the original PO/GR, but is applied to base-unit stock
// columns unconverted. Returning "1 BOX" (conversionToBase=12) under-
// deducts stock by a factor of 12 instead of removing the 12 PCS that
// were actually added to stock when that box was originally received.

let store = null
let category = null
let adminUser = null
let token = null
let ingredient = null
let poId = null

const CONVERSION = 12
const RECEIVE_QTY_BOXES = 2 // -> 24 pcs into stock
const RETURN_QTY_BOXES = 1 // -> should remove 12 pcs from stock

const nextTag = () => `UOM_RETURN_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'UOM_RETURN_STORE', status: 'active' }))
  category = await db.category.create({ name: 'UOM_RETURN_CATEGORY' })
  adminUser = await db.user.create({
    userName: 'admin_uom_return',
    email: 'admin_uom_return@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )

  ingredient = await db.ingredient.create({
    store: store.id,
    name: nextTag(),
    stock: 0,
    minStock: 0,
    unit: 'box',
    baseUnit: 'pcs',
    conversionFactor: CONVERSION,
    costPrice: 0,
    status: 'active'
  })

  const poRes = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      status: 'ordered',
      items: [
        {
          ingredient: ingredient.id,
          ingredientName: ingredient.name,
          quantity: RECEIVE_QTY_BOXES,
          unit: 'box',
          conversionToBase: CONVERSION,
          price: 50000
        }
      ]
    })
  expect(poRes.status).toBe(201)
  poId = poRes.body.data.id
  const poItemId = poRes.body.data.items[0].id

  const grRes = await request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      purchaseOrderId: poId,
      status: 'completed',
      items: [
        {
          purchaseOrderItem: poItemId,
          ingredient: ingredient.id,
          ingredientName: ingredient.name,
          qtyReceived: RECEIVE_QTY_BOXES,
          unit: 'box',
          conversionToBase: CONVERSION,
          price: 50000,
          costPrice: 50000
        }
      ]
    })
  expect(grRes.status).toBe(201)

  const afterReceive = await db.ingredient.findByPk(ingredient.id)
  expect(Number(afterReceive.stock)).toBe(RECEIVE_QTY_BOXES * CONVERSION) // 24 pcs
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  await db.purchase_return_item.destroy({ where: {}, force: true })
  const returns = await db.purchase_return.findAll({ where: { store: store.id }, attributes: ['id'] })
  await db.purchase_return.destroy({ where: { id: returns.map((r) => r.id) }, force: true })
  await db.goodsReceiptItem.destroy({ where: {}, force: true })
  const receipts = await db.goodsReceipt.findAll({ where: { store: store.id }, attributes: ['id'] })
  await db.goodsReceipt.destroy({ where: { id: receipts.map((r) => r.id) }, force: true })
  await db.purchase_order_item.destroy({ where: { purchaseOrder: poId }, force: true })
  await db.purchase_order.destroy({ where: { id: poId }, force: true })
  await db.ingredient.destroy({ where: { store: store.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: adminUser?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('POST /purchase-return/create — unit conversion on stock reversal', () => {
  test('returning a purchase-unit quantity deducts the correctly converted base-unit quantity from stock', async () => {
    const beforeReturn = await db.ingredient.findByPk(ingredient.id)
    expect(Number(beforeReturn.stock)).toBe(RECEIVE_QTY_BOXES * CONVERSION) // 24

    const returnRes = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${token}`)
      .send({
        purchaseOrder: poId,
        reason: 'UOM audit test',
        items: [
          {
            ingredient: ingredient.id,
            ingredientName: ingredient.name,
            qty: RETURN_QTY_BOXES,
            unit: 'box'
          }
        ]
      })

    expect(returnRes.status).toBe(201)

    const afterReturn = await db.ingredient.findByPk(ingredient.id)
    const expectedStock =
      RECEIVE_QTY_BOXES * CONVERSION - RETURN_QTY_BOXES * CONVERSION // 24 - 12 = 12
    expect(Number(afterReturn.stock)).toBe(expectedStock)
  })
})
