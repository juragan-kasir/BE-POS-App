process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 7 — Goods Receipt weighted-average cost formula
// correctness, discovered while proving Batch 6's F21-08 concurrency fix.
//
// applyCostPrice() re-reads the product/ingredient row AFTER the current
// receipt's own atomic stock increment already committed within the same
// transaction (read-your-own-writes) — so the "existing stock" term in
// the weighted-average formula already includes THIS receipt's own
// incoming quantity, double-counting it in both the numerator and
// denominator.
//
// Example: stock=100, cost=5000, receiving 50 @ 8000.
// Correct:   (100*5000 + 50*8000) / (100+50)     = 6000
// Buggy:     ((100+50)*5000 + 50*8000) / (100+50+50) = 5750

let store = null
let category = null
let adminUser = null
let token = null
let tagCounter = 0

const nextTag = () => {
  tagCounter += 1
  return `GR_COST_FORMULA_${Date.now()}_${tagCounter}`
}

beforeAll(async () => {
  store = await db.location.create({ name: 'GR_COST_FORMULA_STORE', status: 'active' })
  category = await db.category.create({ name: 'GR_COST_FORMULA_CATEGORY' })
  adminUser = await db.user.create({
    userName: 'admin_gr_cost_formula',
    email: 'admin_gr_cost_formula@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
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
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.ingredient.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { category: category.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: adminUser?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

const makeProduct = (stock, costPrice) =>
  db.product.create({
    nameProduct: nextTag(),
    category: category.id,
    price: 20000,
    stock,
    costPrice
  })

const makeIngredient = (stock, costPrice) =>
  db.ingredient.create({
    store: store.id,
    name: nextTag(),
    stock,
    minStock: 0,
    unit: 'g',
    baseUnit: 'g',
    conversionFactor: 1,
    costPrice,
    status: 'active'
  })

const makePOForProduct = async (product, qty, unitCost) => {
  const res = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      status: 'ordered',
      items: [{ product: product.id, quantity: qty, price: unitCost }]
    })
  return { po: res.body.data, poItemId: res.body.data.items[0].id }
}

const makePOForIngredient = async (ingredient, qty, unitCost) => {
  const res = await request(app)
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
  return { po: res.body.data, poItemId: res.body.data.items[0].id }
}

const receiveProduct = async (product, qty, unitCost) => {
  const { po, poItemId } = await makePOForProduct(product, qty, unitCost)
  const res = await request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      purchaseOrderId: po.id,
      status: 'completed',
      items: [
        {
          purchaseOrderItem: poItemId,
          product: product.id,
          qtyReceived: qty,
          price: unitCost,
          costPrice: unitCost
        }
      ]
    })
  expect(res.status).toBe(201)
  return db.product.findByPk(product.id)
}

const receiveIngredient = async (ingredient, qty, unitCost) => {
  const { po, poItemId } = await makePOForIngredient(ingredient, qty, unitCost)
  const res = await request(app)
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
  expect(res.status).toBe(201)
  return db.ingredient.findByPk(ingredient.id)
}

describe('Goods Receipt weighted-average cost — product path', () => {
  test('a single receipt computes the correct weighted average, not a double-counted one', async () => {
    const product = await makeProduct(100, 5000)
    const updated = await receiveProduct(product, 50, 8000)

    expect(Number(updated.stock)).toBe(150)
    expect(updated.costPrice).toBe(6000) // (100*5000 + 50*8000) / 150
  })

  test('a second sequential receipt correctly chains off the first, no double count', async () => {
    const product = await makeProduct(100, 5000)
    await receiveProduct(product, 50, 8000)
    const updated = await receiveProduct(product, 50, 7000)

    expect(Number(updated.stock)).toBe(200)
    expect(updated.costPrice).toBe(6250) // (150*6000 + 50*7000) / 200
  })
})

describe('Goods Receipt weighted-average cost — ingredient path', () => {
  test('a single receipt computes the correct weighted average for an ingredient', async () => {
    const ingredient = await makeIngredient(100, 5000)
    const updated = await receiveIngredient(ingredient, 50, 8000)

    expect(Number(updated.stock)).toBe(150)
    expect(updated.costPrice).toBe(6000)
  })

  test('a second sequential ingredient receipt correctly chains off the first', async () => {
    const ingredient = await makeIngredient(100, 5000)
    await receiveIngredient(ingredient, 50, 8000)
    const updated = await receiveIngredient(ingredient, 50, 7000)

    expect(Number(updated.stock)).toBe(200)
    expect(updated.costPrice).toBe(6250)
  })
})

describe('Goods Receipt weighted-average cost — edge cases', () => {
  test('existing stock = 0: incoming cost becomes the resulting average cost (product)', async () => {
    const product = await makeProduct(0, 0)
    const updated = await receiveProduct(product, 40, 9000)

    expect(Number(updated.stock)).toBe(40)
    expect(updated.costPrice).toBe(9000)
  })

  test('existing stock = 0: incoming cost becomes the resulting average cost (ingredient)', async () => {
    const ingredient = await makeIngredient(0, 0)
    const updated = await receiveIngredient(ingredient, 40, 9000)

    expect(Number(updated.stock)).toBe(40)
    expect(updated.costPrice).toBe(9000)
  })

  // ingredient.costPrice is the price of one PURCHASE unit while stock is in
  // base units (itemCostService). 5 kg in stock at Rp25.000/kg, receiving
  // 2 kg at Rp26.000/kg: (5000 g × Rp25 + 2000 g × Rp26) / 7000 g × 1000 =
  // Rp25.285,71 → Rp25.286 per kg. Averaging the stored per-kg price against
  // the per-gram receipt cost produced Rp17.865.
  test('purchase-unit ingredient (kg, stocked in g): average stays a per-kg price', async () => {
    const ingredient = await db.ingredient.create({
      store: store.id,
      name: nextTag(),
      stock: 5000,
      minStock: 0,
      unit: 'kg',
      baseUnit: 'g',
      conversionFactor: 1000,
      costPrice: 25000,
      status: 'active'
    })
    const { po, poItemId } = await makePOForIngredient(ingredient, 2, 26000)
    const res = await request(app)
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
            qtyReceived: 2,
            conversionToBase: 1000,
            price: 26000,
            costPrice: 26000
          }
        ]
      })
    expect(res.status).toBe(201)

    const updated = await db.ingredient.findByPk(ingredient.id)
    expect(Number(updated.stock)).toBe(7000)
    expect(updated.costPrice).toBe(25286)
  })

  test('existing cost = 0 with existing stock > 0: old stock contributes zero value to the blend', async () => {
    const product = await makeProduct(100, 0)
    const updated = await receiveProduct(product, 50, 8000)

    expect(Number(updated.stock)).toBe(150)
    // (100*0 + 50*8000) / 150 = 2666.67 -> rounds to 2667
    expect(updated.costPrice).toBe(2667)
  })
})
