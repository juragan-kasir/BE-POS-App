process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 14 — cross-module inventory lifecycle audit.
//
// Batch 13 fixed purchase-return CREATION so the return's purchase-unit
// `qty` is converted to base stock units (× conversionToBase) before
// deducting stock. reject() is the matching REVERSAL of that same
// deduction (a rejected return means the goods were never actually
// accepted back, so the earlier deduction must be undone) — but reject()
// still applies the raw, unconverted `item.qty` as the reversal delta
// (both the product branch via adjustProductStock({ deltaQty: qty, ... })
// and the ingredient branch via `ingredient.update({ stock: oldStock + qty })`).
//
// Reversal matrix invariant: forward delta + reverse delta must equal 0
// (in the same base unit). Batch 13 made the forward delta
// `-qty * conversionToBase`; reject()'s reverse delta is still `+qty`
// (unconverted) — they no longer cancel, so rejecting a return permanently
// strands base-unit stock that was correctly deducted at creation but
// never correctly restored.

let store = null
let category = null
let adminUser = null
let token = null
let ingredient = null
let poId = null
let returnId = null

const CONVERSION = 12
const RECEIVE_QTY_BOXES = 2 // -> 24 pcs into stock
const RETURN_QTY_BOXES = 1 // -> 12 pcs deducted at creation (Batch 13, correct)

const nextTag = () => `UOM_REJECT_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'UOM_REJECT_STORE', status: 'active' }))
  category = await db.category.create({ name: 'UOM_REJECT_CATEGORY' })
  adminUser = await db.user.create({
    userName: 'admin_uom_reject',
    email: 'admin_uom_reject@test.com',
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

  const returnRes = await request(app)
    .post('/purchase-return/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      purchaseOrder: poId,
      reason: 'UOM reversal audit',
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
  returnId = returnRes.body.data.id

  const afterReturn = await db.ingredient.findByPk(ingredient.id)
  // Batch 13, already-proven-correct forward deduction: 24 - 12 = 12
  expect(Number(afterReturn.stock)).toBe(12)
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  await db.purchase_return_item.destroy({ where: { purchaseReturn: returnId }, force: true })
  await db.purchase_return.destroy({ where: { id: returnId }, force: true })
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

describe('PATCH /purchase-return/reject/:id — reversal must undo the converted base-unit deduction', () => {
  test('rejecting a return restores the full converted quantity, not the raw purchase-unit quantity', async () => {
    const rejectRes = await request(app)
      .patch(`/purchase-return/reject/${returnId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(rejectRes.status).toBe(200)

    const afterReject = await db.ingredient.findByPk(ingredient.id)
    // 12 (post-return) + 12 (correct reversal of the 1-box/12-pcs deduction) = 24
    expect(Number(afterReject.stock)).toBe(RECEIVE_QTY_BOXES * CONVERSION)
  })
})
