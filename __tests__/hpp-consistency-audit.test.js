process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 8 — HPP-01 audit.
//
// Traces the full chain: BOM creation snapshot -> Batch 7 Goods Receipt
// weighted-average ingredient cost update -> BOM refresh lifecycle.
//
// Audit finding: product.hppPerPorsi is an intentional, persisted
// snapshot recalculated ONLY at the BOM write lifecycle (create/update),
// using the ingredient cost current AT THAT MOMENT. It is never
// recalculated as a side effect of an ingredient cost change (whether
// via Goods Receipt, manual edit, or import) — this is uniform across
// every ingredient-cost mutation path in the codebase, and no read path
// (BOM get-all/get-by-id/get-by-product, reporting) treats hppPerPorsi
// as live-derived. This test locks in that confirmed-safe behavior so a
// future change cannot silently turn it into a partial/inconsistent
// live-calculation without failing here.

let store = null
let category = null
let adminUser = null
let token = null
let product = null
let ingredient = null
let bomHeader = null
let tagCounter = 0

const nextTag = () => {
  tagCounter += 1
  return `HPP_AUDIT_${Date.now()}_${tagCounter}`
}

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'HPP_AUDIT_STORE', status: 'active' }))
  category = await db.category.create({ name: 'HPP_AUDIT_CATEGORY' })
  adminUser = await db.user.create({
    userName: 'admin_hpp_audit',
    email: 'admin_hpp_audit@test.com',
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
    stock: 100,
    minStock: 0,
    unit: 'g',
    baseUnit: 'g',
    conversionFactor: 1,
    costPrice: 5000,
    status: 'active'
  })

  product = await db.product.create({
    nameProduct: nextTag(),
    category: category.id,
    price: 20000,
    inventoryMode: 'hybrid'
  })
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
  await db.bom_line.destroy({ where: { bomHeaderId: bomHeader?.id }, force: true })
  await db.bom_header.destroy({ where: { id: bomHeader?.id }, force: true })
  await db.ingredient.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: adminUser?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

const receiveIngredient = async (qty, unitCost) => {
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
          quantity: qty,
          price: unitCost
        }
      ]
    })
  const po = poRes.body.data
  const poItemId = po.items[0].id

  const grRes = await request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      purchaseOrderId: po.id,
      status: 'completed',
      items: [
        {
          purchaseOrderItem: poItemId,
          ingredient: ingredient.id,
          ingredientName: ingredient.name,
          qtyReceived: qty,
          price: unitCost,
          costPrice: unitCost
        }
      ]
    })
  expect(grRes.status).toBe(201)
}

describe('HPP-01 — BOM HPP snapshot consistency across ingredient cost changes', () => {
  test('BOM create computes hppPerPorsi from ingredient cost at authoring time', async () => {
    const res = await request(app)
      .post('/bom/add')
      .set('Authorization', `Bearer ${token}`)
      .send({
        productId: product.id,
        name: 'HPP_AUDIT_RECIPE',
        status: 'active',
        lines: [{ ingredientId: ingredient.id, qty: 1, unit: 'g' }]
      })

    expect(res.status).toBe(201)
    bomHeader = res.body.data

    const updatedProduct = await db.product.findByPk(product.id)
    expect(Number(updatedProduct.hppPerPorsi)).toBe(5000) // 1 * 5000
  })

  test('an ingredient cost change via Goods Receipt does NOT retroactively mutate the already-persisted BOM snapshot', async () => {
    // Batch 7 weighted average: (100*5000 + 50*8000) / 150 = 6000
    await receiveIngredient(50, 8000)

    const updatedIngredient = await db.ingredient.findByPk(ingredient.id)
    expect(Number(updatedIngredient.costPrice)).toBe(6000)

    const productAfterReceipt = await db.product.findByPk(product.id)
    expect(Number(productAfterReceipt.hppPerPorsi)).toBe(5000) // unchanged snapshot
  })

  test('a BOM update (even without changing lines) refreshes hppPerPorsi from current ingredient cost', async () => {
    const res = await request(app)
      .put(`/bom/edit/${bomHeader.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'refresh after ingredient cost change' })

    expect(res.status).toBe(200)

    const refreshedProduct = await db.product.findByPk(product.id)
    expect(Number(refreshedProduct.hppPerPorsi)).toBe(6000) // 1 * 6000, current cost
  })
})
