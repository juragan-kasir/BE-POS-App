process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { recipeCosting, recipeYield } = require('../api/service/itemCostService')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BRD "Harga Modal, HPP, Resep/BOM & Stok" (2026-10-26), phase 1: one HPP
// for a recipe product. The recipe screen, the product screens and the sale
// snapshot all use recipeCosting — recipe cost / yield, with a status
// (auto / provisional / unavailable) and food cost + margin from that same
// HPP — read live, so an ingredient price change shows at once while past
// sales keep their snapshot.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let otherStore = null
let category = null
let admin = null
let token = null
const productIds = []
const ingredientIds = []
const bomIds = []
const as = () => ({ Authorization: `Bearer ${token}` })

async function makeIngredient(name, { unit, baseUnit, conversionFactor, costPrice, onStore }) {
  const ing = await db.ingredient.create({
    store: (onStore || store).id,
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
  await db.stock_history.create({
    store: (onStore || store).id,
    ingredient: ing.id,
    referenceType: 'adjustment',
    referenceId: ing.id,
    quantityBefore: 0,
    quantityChange: 100000,
    quantityAfter: 100000,
    notes: 'test opening stock'
  })
  return ing
}

async function makeProduct(name, price, { costPrice = 0 } = {}) {
  const p = await db.product.create({
    nameProduct: unique(name),
    category: category.id,
    price,
    costPrice,
    inventoryMode: 'make_to_order',
    stock: 0,
    status: 'active'
  })
  productIds.push(p.id)
  await db.product_store.create({ product: p.id, store: store.id }).catch(() => {})
  return p
}

async function addBom(product, lines, totalQty) {
  const res = await request(app)
    .post('/bom/add')
    .set(as())
    .send({
      productId: product.id,
      name: product.nameProduct,
      ...(totalQty !== undefined ? { totalQty } : {}),
      lines: lines.map(([ing, qty]) => ({ ingredientId: ing.id, qty, unit: ing.baseUnit }))
    })
  if (res.body?.data?.id) bomIds.push(res.body.data.id)
  return res
}

const costingOf = async (product) => {
  const res = await request(app).get(`/bom/costing/${product.id}`).set(as())
  expect(res.status).toBe(200)
  return res.body.data
}

const sell = (items) =>
  request(app)
    .post('/order/create')
    .set(as())
    .send({
      store: store.id,
      items,
      paymentMethod: 'cash',
      idempotencyKey: unique('hpp1')
    })

beforeAll(async () => {
  store = await db.location.create({ name: unique('HPP1_STORE'), status: 'active' })
  otherStore = await db.location.create({ name: unique('HPP1_OTHER'), status: 'active' })
  category = await db.category.create({ name: unique('HPP1_CAT') })
  await db.taxConfig.create({ store: store.id, name: unique('HPP1_PPN'), rate: 0, type: 'ppn', status: 'active' })
  admin = await db.user.create({
    userName: unique('hpp1_admin'),
    email: `${unique('hpp1_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken({ id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id }, JWT_SECRET)

  const open = await request(app).post('/cash-register/open').set(as()).send({ store: store.id, openingBalance: 0 })
  if (![200, 201].includes(open.status)) throw new Error('register setup failed: ' + JSON.stringify(open.body))
})

afterAll(async () => {
  const orderIds = (await db.order.findAll({ where: { store: store.id }, attributes: ['id'] })).map((o) => o.id)
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.stock_history.destroy({ where: { store: [store.id, otherStore.id] }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  const allBoms = await db.bom_header.findAll({ where: { productId: productIds }, attributes: ['id'], paranoid: false })
  const allBomIds = [...new Set([...bomIds, ...allBoms.map((b) => b.id)])]
  await db.bom_line.destroy({ where: { bomHeaderId: allBomIds }, force: true })
  await db.bom_header.destroy({ where: { id: allBomIds }, force: true })
  await db.best_selling.destroy({ where: { productId: productIds }, force: true }).catch(() => {})
  await db.product_store.destroy({ where: { product: productIds }, force: true })
  await db.product_store_stock.destroy({ where: { product: productIds }, force: true })
  await db.product.destroy({ where: { id: productIds }, force: true })
  await db.ingredient.destroy({ where: { id: ingredientIds }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: admin?.id }, force: true })
  await db.location.destroy({ where: { id: [store?.id, otherStore?.id] }, force: true })
})

describe('recipeCosting rule', () => {
  const ingredients = new Map([
    [1, { name: 'Bakso', costPrice: 25000, conversionFactor: 25 }], // Rp1.000 / butir
    [2, { name: 'Susu', costPrice: 45600, conversionFactor: 1000 }], // Rp45,60 / ml
    [3, { name: 'Keju', costPrice: 0, conversionFactor: 1 }]
  ])

  test('AC-03: a recipe of Rp75.000 that yields 10 portions costs Rp7.500 a portion', () => {
    const c = recipeCosting({ lines: [{ ingredientId: 1, qty: 75 }], ingredientById: ingredients, yieldQty: 10, price: 15000 })
    expect(c).toMatchObject({
      status: 'auto',
      yieldQty: 10,
      recipeTotalCost: 75000,
      hppPerPortion: 7500,
      foodCostPercent: 50,
      marginPercent: 50,
      grossProfit: 7500,
      missingCost: []
    })
  })

  test('AC-04: milk at Rp45.600 per 1.000 ml, 100 ml per portion → Rp4.560', () => {
    const c = recipeCosting({ lines: [{ ingredientId: 2, qty: 100 }], ingredientById: ingredients })
    expect(c.hppPerPortion).toBe(4560)
  })

  test('AC-02: an incomplete recipe is provisional with an estimate, unavailable without one', () => {
    const lines = [{ ingredientId: 1, qty: 5 }, { ingredientId: 3, qty: 20 }]
    const provisional = recipeCosting({ lines, ingredientById: ingredients, estimate: 6000, price: 15000 })
    expect(provisional).toMatchObject({ status: 'provisional', hppPerPortion: 6000, marginPercent: 60, recipeTotalCost: null })
    expect(provisional.missingCost).toEqual([{ ingredientId: 3, name: 'Keju' }])

    const unavailable = recipeCosting({ lines, ingredientById: ingredients, price: 15000 })
    expect(unavailable).toMatchObject({ status: 'unavailable', hppPerPortion: null, foodCostPercent: null, marginPercent: null })
    expect(recipeCosting({ lines: [], estimate: 0 }).status).toBe('unavailable')
    expect(recipeCosting({ lines: [], estimate: 5000 })).toMatchObject({ status: 'provisional', hppPerPortion: 5000 })
  })

  test('a complete recipe ignores the manual estimate', () => {
    const c = recipeCosting({ lines: [{ ingredientId: 1, qty: 5 }], ingredientById: ingredients, estimate: 6000, price: 15000 })
    expect(c).toMatchObject({ status: 'auto', hppPerPortion: 5000 })
  })

  test('older recipes without a yield count as one portion', () => {
    expect(recipeYield({ totalQty: 0 })).toBe(1)
    expect(recipeYield({ totalQty: null })).toBe(1)
    expect(recipeYield({ totalQty: 10 })).toBe(10)
  })
})

describe('recipe HPP end to end', () => {
  let bakso = null
  let mie = null
  let product = null

  beforeAll(async () => {
    bakso = await makeIngredient('Bakso', { unit: 'kg', baseUnit: 'butir', conversionFactor: 25, costPrice: 25000 })
    mie = await makeIngredient('Mie', { unit: 'kg', baseUnit: 'g', conversionFactor: 1000, costPrice: 20000 })
    // Manual "Harga Modal" Rp6.000 — the inconsistent figure from BRD §8.1.
    product = await makeProduct('BAKSO HALUS', 15000, { costPrice: 6000 })
    // A pot of 10 portions: 50 butir (Rp50.000) + 1.250 g mie (Rp25.000).
    const res = await addBom(product, [[bakso, 50], [mie, 1250]], 10)
    expect(res.status).toBe(201)
  })

  test('AC-01: the recipe screen, the product snapshot and the sale use one HPP', async () => {
    const costing = await costingOf(product)
    expect(costing.recipes).toHaveLength(1)
    expect(costing.recipes[0]).toMatchObject({
      store: store.id,
      status: 'auto',
      yieldQty: 10,
      recipeTotalCost: 75000,
      hppPerPortion: 7500,
      foodCostPercent: 50,
      marginPercent: 50
    })
    expect(costing.estimate).toBe(6000)

    await product.reload()
    expect(Number(product.hppPerPorsi)).toBe(7500)
    expect(Number(product.marginPersen)).toBe(50)

    const list = await request(app).get('/bom/get-all').set(as())
    const row = list.body.data.find((b) => b.productId === product.id)
    expect(row.costing).toMatchObject({ status: 'auto', hppPerPortion: 7500 })
  })

  test('AC-08: selling 3 portions of a 10-portion recipe deducts 3/10 of each line', async () => {
    const res = await sell([{ product: product.id, quantity: 3 }])
    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id } })
    expect(Number(line.hppSnapshot)).toBe(7500)

    const rows = await db.stock_history.findAll({ where: { referenceType: 'sale', referenceId: res.body.data.id } })
    const change = (ing) => Number(rows.find((r) => r.ingredient === ing.id).quantityChange)
    expect(change(bakso)).toBe(-15)
    expect(change(mie)).toBe(-375)
    expect(rows.filter((r) => r.ingredient == null)).toHaveLength(0)
    await bakso.reload()
    expect(Number(bakso.stock)).toBe(100000 - 15)
  })

  test('AC-11: a price rise changes the live HPP at once, never a past sale', async () => {
    const before = await sell([{ product: product.id, quantity: 1 }])
    expect(before.status).toBe(201)

    // Bakso Rp25.000 → Rp50.000 per kg: the pot now costs Rp125.000.
    await bakso.update({ costPrice: 50000 })
    const costing = await costingOf(product)
    expect(costing.recipes[0]).toMatchObject({ status: 'auto', hppPerPortion: 12500 })

    const old = await db.order_item.findOne({ where: { order: before.body.data.id } })
    expect(Number(old.hppSnapshot)).toBe(7500)
    const after = await sell([{ product: product.id, quantity: 1 }])
    const fresh = await db.order_item.findOne({ where: { order: after.body.data.id } })
    expect(Number(fresh.hppSnapshot)).toBe(12500)
    await bakso.update({ costPrice: 25000 })
  })

  test('changing only the yield re-costs the recipe', async () => {
    const bom = await db.bom_header.findOne({ where: { productId: product.id, store: store.id } })
    const res = await request(app).put(`/bom/edit/${bom.id}`).set(as()).send({ totalQty: 5 })
    expect(res.status).toBe(200)
    expect((await costingOf(product)).recipes[0]).toMatchObject({ yieldQty: 5, hppPerPortion: 15000 })
    await product.reload()
    expect(Number(product.hppPerPorsi)).toBe(15000)
    await request(app).put(`/bom/edit/${bom.id}`).set(as()).send({ totalQty: 10 })
  })

  test('a yield below one portion is refused', async () => {
    const bom = await db.bom_header.findOne({ where: { productId: product.id, store: store.id } })
    for (const totalQty of [0, -1, 2.5]) {
      const res = await request(app).put(`/bom/edit/${bom.id}`).set(as()).send({ totalQty })
      expect(res.status).toBe(400)
    }
    expect((await costingOf(product)).recipes[0].yieldQty).toBe(10)
  })
})

describe('incomplete recipes', () => {
  test('provisional: an uncosted ingredient uses the estimate, on screen and in the sale', async () => {
    const mie = await makeIngredient('Mie2', { unit: 'kg', baseUnit: 'g', conversionFactor: 1000, costPrice: 20000 })
    const keju = await makeIngredient('Keju2', { unit: 'pack', baseUnit: 'g', conversionFactor: 200, costPrice: 0 })
    const product = await makeProduct('MIE KEJU', 18000, { costPrice: 9000 })
    expect((await addBom(product, [[mie, 100], [keju, 20]])).status).toBe(201)

    const recipe = (await costingOf(product)).recipes[0]
    expect(recipe).toMatchObject({ status: 'provisional', hppPerPortion: 9000, marginPercent: 50 })
    expect(recipe.missingCost.map((m) => m.ingredientId)).toEqual([keju.id])
    // The stored product snapshot never holds a partial sum.
    await product.reload()
    expect(Number(product.hppPerPorsi)).toBe(0)

    const res = await sell([{ product: product.id, quantity: 1 }])
    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id } })
    expect(Number(line.hppSnapshot)).toBe(9000)
  })

  test('unavailable: no cost and no estimate leaves the HPP empty', async () => {
    const keju = await makeIngredient('Keju3', { unit: 'pack', baseUnit: 'g', conversionFactor: 200, costPrice: 0 })
    const product = await makeProduct('KEJU BAKAR', 12000)
    expect((await addBom(product, [[keju, 20]])).status).toBe(201)
    expect((await costingOf(product)).recipes[0]).toMatchObject({
      status: 'unavailable',
      hppPerPortion: null,
      marginPercent: null
    })
    const res = await sell([{ product: product.id, quantity: 1 }])
    expect(res.status).toBe(201)
    const line = await db.order_item.findOne({ where: { order: res.body.data.id } })
    expect(line.hppSnapshot).toBeNull()
  })
})

describe('costing endpoint scope', () => {
  test('a store-bound admin sees only its own outlet recipe', async () => {
    const product = await makeProduct('ES TEH', 5000)
    const own = await makeIngredient('Teh', { unit: 'pack', baseUnit: 'g', conversionFactor: 100, costPrice: 10000 })
    const foreign = await makeIngredient('TehLain', { unit: 'pack', baseUnit: 'g', conversionFactor: 100, costPrice: 10000, onStore: otherStore })
    expect((await addBom(product, [[own, 10]])).status).toBe(201)
    const otherBom = await db.bom_header.create({ store: otherStore.id, productId: product.id, name: 'other', status: 'active' })
    bomIds.push(otherBom.id)
    await db.bom_line.create({ bomHeaderId: otherBom.id, ingredientId: foreign.id, qty: 20, unit: 'g' })

    const recipes = (await costingOf(product)).recipes
    expect(recipes.map((r) => r.store)).toEqual([store.id])
    expect(recipes[0].hppPerPortion).toBe(1000)
  })

  test('a product without a recipe returns no recipes; a bad id is refused', async () => {
    const product = await makeProduct('KERUPUK', 2000, { costPrice: 1000 })
    expect((await costingOf(product)).recipes).toEqual([])
    expect((await request(app).get('/bom/costing/abc').set(as())).status).toBe(400)
    expect((await request(app).get('/bom/costing/999999999').set(as())).status).toBe(404)
  })
})
