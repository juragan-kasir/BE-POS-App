process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { computeOrderCogs } = require('../api/service/accountingService')
const {
  ingredientBaseUnitCost,
  ingredientPurchaseUnitCost,
  recipeUnitCost,
  bundleUnitCost
} = require('../api/service/itemCostService')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Real HPP (itemCostService): order_item.hppSnapshot is the unit cost at
// sale time — the outlet recipe at the ingredients' purchase prices, or the
// product's purchase cost — and NULL when unknown. It used to fall back to
// the selling price, so every product without a purchase price reported a
// 100 % food cost and zero profit.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let category = null
let admin = null
let token = null
const tableIds = []
const productIds = []
const ingredientIds = []
const bomIds = []
const as = () => ({ Authorization: `Bearer ${token}` })

// Bakso: Rp25.000 per kg of 25 butir → Rp1.000 per butir.
// Mie:   Rp20.000 per kg of 1000 g  → Rp20 per g.
// Recipe per portion: 5 butir + 100 g → Rp7.000.
const RECIPE_COST = 5 * 1000 + 100 * 20

let recipeProduct = null
let unknownRecipeProduct = null
let costedProduct = null
let uncostedProduct = null

async function makeIngredient(name, unit, baseUnit, conversionFactor, costPrice) {
  const ing = await db.ingredient.create({
    store: store.id,
    name: unique(name),
    stock: 100000,
    minStock: 0,
    unit,
    baseUnit,
    conversionFactor,
    costPrice,
    status: 'active'
  })
  ingredientIds.push(ing.id)
  // Opening stock goes through a recorded event like the API's adjustment,
  // so recipe deduction treats it as counted stock.
  await db.stock_history.create({
    store: store.id,
    ingredient: ing.id,
    type: 'adjustment',
    referenceType: 'adjustment',
    referenceId: ing.id,
    quantityBefore: 0,
    quantityChange: 100000,
    quantityAfter: 100000,
    notes: 'test opening stock'
  })
  return ing
}

async function makeProduct(name, price, { costPrice = 0, inventoryMode = 'stocked' } = {}) {
  const p = await db.product.create({
    nameProduct: unique(name),
    category: category.id,
    price,
    costPrice,
    inventoryMode,
    stock: 1000,
    status: 'active'
  })
  productIds.push(p.id)
  await db.product_store_stock.create({ product: p.id, store: store.id, stock: 1000 })
  await db.product_store.create({ product: p.id, store: store.id }).catch(() => {})
  return p
}

async function makeRecipe(product, lines) {
  const header = await db.bom_header.create({ store: store.id, productId: product.id, name: product.nameProduct, status: 'active' })
  bomIds.push(header.id)
  for (const [ingredient, qty] of lines) {
    await db.bom_line.create({ bomHeaderId: header.id, ingredientId: ingredient.id, qty, unit: ingredient.baseUnit })
  }
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('HPP_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('HPP_CAT') })
  await db.taxConfig.create({ store: store.id, name: unique('HPP_PPN'), rate: 0, type: 'ppn', status: 'active' })
  admin = await db.user.create({
    userName: unique('hpp_admin'),
    email: `${unique('hpp_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken({ id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id }, JWT_SECRET)

  const bakso = await makeIngredient('Bakso', 'kg', 'butir', 25, 25000)
  const mie = await makeIngredient('Mie', 'kg', 'g', 1000, 20000)
  const keju = await makeIngredient('Keju', 'pack', 'g', 200, 0)

  recipeProduct = await makeProduct('BAKSO MIE', 15000, { inventoryMode: 'make_to_order' })
  await makeRecipe(recipeProduct, [[bakso, 5], [mie, 100]])
  unknownRecipeProduct = await makeProduct('MIE KEJU', 18000, { inventoryMode: 'make_to_order' })
  await makeRecipe(unknownRecipeProduct, [[mie, 100], [keju, 20]])
  costedProduct = await makeProduct('AIR MINERAL', 5000, { costPrice: 3000 })
  uncostedProduct = await makeProduct('KERUPUK', 2000)

  const open = await request(app).post('/cash-register/open').set(as()).send({ store: store.id, openingBalance: 0 })
  if (![200, 201].includes(open.status)) throw new Error('register setup failed: ' + JSON.stringify(open.body))
})

afterAll(async () => {
  const orderIds = (await db.order.findAll({ where: { store: store.id }, attributes: ['id'] })).map((o) => o.id)
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.table.destroy({ where: { id: tableIds }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.bom_line.destroy({ where: { bomHeaderId: bomIds }, force: true })
  await db.bom_header.destroy({ where: { id: bomIds }, force: true })
  await db.product_store.destroy({ where: { product: productIds }, force: true })
  await db.product_store_stock.destroy({ where: { product: productIds }, force: true })
  await db.best_selling.destroy({ where: { product: productIds }, force: true }).catch(() => {})
  await db.product.destroy({ where: { id: productIds }, force: true })
  await db.ingredient.destroy({ where: { id: ingredientIds }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: admin?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('itemCostService units', () => {
  test('ingredient cost converts between purchase and base units', () => {
    const ing = { costPrice: 25000, conversionFactor: 25 }
    expect(ingredientBaseUnitCost(ing)).toBe(1000)
    expect(ingredientPurchaseUnitCost(1011.43, ing)).toBe(25286)
    expect(ingredientBaseUnitCost({ costPrice: 5000, conversionFactor: 0 })).toBe(5000)
  })

  test('a recipe with an uncosted ingredient has no cost, never a partial one', () => {
    const ingredients = new Map([[1, { costPrice: 25000, conversionFactor: 25 }], [2, { costPrice: 0, conversionFactor: 1 }]])
    expect(recipeUnitCost([{ ingredientId: 1, qty: 5 }], ingredients)).toBe(5000)
    expect(recipeUnitCost([{ ingredientId: 1, qty: 5 }, { ingredientId: 2, qty: 1 }], ingredients)).toBeNull()
  })

  test('a bundle costs its components, or nothing when one is unknown', () => {
    const costs = new Map([[1, 7000], [2, 3000], [3, null]])
    expect(bundleUnitCost({ items: [{ product: 1, quantity: 2 }, { product: 2, quantity: 1 }] }, costs)).toBe(17000)
    expect(bundleUnitCost({ items: [{ product: 1, quantity: 1 }, { product: 3, quantity: 1 }] }, costs)).toBeNull()
  })
})

describe('HPP captured at sale time', () => {
  let counterOrderId = null

  test('counter sale: recipe cost, purchase cost, and NULL for an unknown cost', async () => {
    const res = await request(app)
      .post('/order/create')
      .set(as())
      .send({
        store: store.id,
        items: [
          { product: recipeProduct.id, quantity: 2 },
          { product: unknownRecipeProduct.id, quantity: 1 },
          { product: costedProduct.id, quantity: 1 },
          { product: uncostedProduct.id, quantity: 3 }
        ],
        paymentMethod: 'cash',
        cashAmount: 2 * 15000 + 18000 + 5000 + 3 * 2000,
        changeAmount: 0,
        idempotencyKey: unique('hpp')
      })
    expect(res.status).toBe(201)
    counterOrderId = res.body.data.id

    const lines = await db.order_item.findAll({ where: { order: counterOrderId } })
    const snapshot = (p) => {
      const line = lines.find((l) => l.product === p.id)
      return line.hppSnapshot == null ? null : Number(line.hppSnapshot)
    }
    expect(snapshot(recipeProduct)).toBe(RECIPE_COST)
    expect(snapshot(unknownRecipeProduct)).toBeNull()
    expect(snapshot(costedProduct)).toBe(3000)
    expect(snapshot(uncostedProduct)).toBeNull()
  })

  test('COGS journal books the known cost only, never the selling price', async () => {
    expect(await computeOrderCogs(counterOrderId)).toBe(2 * RECIPE_COST + 3000)
  })

  test('QR order captures the same recipe cost', async () => {
    const table = await db.table.create({ store: store.id, name: unique('HPP_TABLE') })
    tableIds.push(table.id)
    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store.id,
        tableId: table.id,
        items: [{ productId: recipeProduct.id, productName: recipeProduct.nameProduct, quantity: 1 }],
        idempotencyKey: unique('hppqr')
      })
    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id } })
    expect(Number(line.hppSnapshot)).toBe(RECIPE_COST)
  })

  test('daily report: HPP excludes unknown costs and reports their quantity', async () => {
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10)
    const res = await request(app).get(`/report/daily?store=${store.id}&startDate=${today}&endDate=${today}`).set(as())
    expect(res.status).toBe(200)
    const row = res.body.data[0]
    expect(Number(row.totalHpp)).toBe(2 * RECIPE_COST + 3000)
    expect(Number(row.qtyTanpaHpp)).toBe(1 + 3)
  })

  test('profit per product flags the units sold without a cost', async () => {
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10)
    const res = await request(app).get(`/report/profit-per-product?store=${store.id}&startDate=${today}&endDate=${today}`).set(as())
    expect(res.status).toBe(200)
    const byId = new Map(res.body.data.map((r) => [Number(r.productId), r]))
    expect(Number(byId.get(recipeProduct.id).totalHpp)).toBe(2 * RECIPE_COST)
    expect(Number(byId.get(recipeProduct.id).qtyTanpaHpp)).toBe(0)
    expect(Number(byId.get(uncostedProduct.id).totalHpp)).toBe(0)
    expect(Number(byId.get(uncostedProduct.id).qtyTanpaHpp)).toBe(3)
  })
})
