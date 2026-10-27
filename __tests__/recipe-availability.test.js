process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { portionsFromStock } = require('../api/service/recipeAvailabilityService')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BRD "Harga Modal, HPP, Resep/BOM & Stok" phase 2: a recipe product is
// available while its ingredients can make a portion — portions = MIN over
// the recipe of FLOOR(stock / use per portion), with the limiting
// ingredient shown (BR-05, FR-09) — never because its own stock is 0
// (AC-07), and an order the ingredients cannot make is refused (BR-06,
// decision: blokir), at the counter and now also when a QR order is placed.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let category = null
let admin = null
let token = null
const productIds = []
const ingredientIds = []
const bomIds = []
const tableIds = []
const as = () => ({ Authorization: `Bearer ${token}` })

let kopi = null
let susu = null
let gula = null
let cappuccino = null
let latte = null
let noRecipe = null
let draftRecipe = null
let airMineral = null

async function makeIngredient(name, baseUnit, stock) {
  const ing = await db.ingredient.create({
    store: store.id,
    name: unique(name),
    stock,
    minStock: 0,
    unit: baseUnit,
    baseUnit,
    conversionFactor: 1,
    costPrice: 10,
    status: 'active'
  })
  ingredientIds.push(ing.id)
  return ing
}

async function makeProduct(name, { inventoryMode = 'make_to_order', stock = 0, minStock = 0 } = {}) {
  const p = await db.product.create({
    nameProduct: unique(name),
    category: category.id,
    price: 20000,
    costPrice: 0,
    inventoryMode,
    stock,
    minStock,
    status: 'active'
  })
  productIds.push(p.id)
  await db.product_store.create({ product: p.id, store: store.id }).catch(() => {})
  await db.product_store_stock.create({ product: p.id, store: store.id, stock })
  return p
}

async function makeRecipe(product, lines, { totalQty = 1, status = 'active' } = {}) {
  const header = await db.bom_header.create({ store: store.id, productId: product.id, name: 'r', totalQty, status })
  bomIds.push(header.id)
  for (const [ing, qty] of lines) {
    await db.bom_line.create({ bomHeaderId: header.id, ingredientId: ing.id, qty, unit: ing.baseUnit })
  }
}

const qrOrder = async (items) => {
  const table = await db.table.create({ store: store.id, name: unique('AV_TABLE') })
  tableIds.push(table.id)
  return request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      items: items.map(([p, quantity]) => ({ productId: p.id, productName: p.nameProduct, quantity })),
      idempotencyKey: unique('avqr')
    })
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('AV_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('AV_CAT') })
  await db.taxConfig.create({ store: store.id, name: unique('AV_PPN'), rate: 0, type: 'ppn', status: 'active' })
  admin = await db.user.create({
    userName: unique('av_admin'),
    email: `${unique('av_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken({ id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id }, JWT_SECRET)

  // BRD §8.3 Cappuccino: kopi 500 g / 10 g, susu 1.000 ml / 100 ml, gula 200 g / 10 g.
  kopi = await makeIngredient('Kopi', 'g', 500)
  susu = await makeIngredient('Susu', 'ml', 1000)
  gula = await makeIngredient('Gula', 'g', 200)
  cappuccino = await makeProduct('CAPPUCCINO', { minStock: 5 })
  await makeRecipe(cappuccino, [[kopi, 10], [susu, 100], [gula, 10]])
  // Latte: a batch of 4 cups uses 600 ml susu → 150 ml a cup.
  latte = await makeProduct('LATTE')
  await makeRecipe(latte, [[susu, 600]], { totalQty: 4 })
  noRecipe = await makeProduct('MENU TANPA RESEP')
  draftRecipe = await makeProduct('MENU DRAFT')
  await makeRecipe(draftRecipe, [[kopi, 10]], { status: 'draft' })
  airMineral = await makeProduct('AIR MINERAL', { inventoryMode: 'stocked', stock: 3, minStock: 5 })

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
  await db.best_selling.destroy({ where: { productId: productIds }, force: true }).catch(() => {})
  await db.product_store.destroy({ where: { product: productIds }, force: true })
  await db.product_store_stock.destroy({ where: { product: productIds }, force: true })
  await db.product.destroy({ where: { id: productIds }, force: true })
  await db.ingredient.destroy({ where: { id: ingredientIds }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: admin?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('portionsFromStock', () => {
  test('floors stock over use per portion, with the recipe yield', () => {
    expect(portionsFromStock(1000, 100, 1)).toBe(10)
    expect(portionsFromStock(999, 100, 1)).toBe(9)
    expect(portionsFromStock(1000, 1000, 3)).toBe(3)
    expect(portionsFromStock(0, 10, 1)).toBe(0)
    expect(portionsFromStock(-5, 10, 1)).toBe(0)
  })

  test('agrees with the deduction rounding (4 dp) at the edge', () => {
    // 1 portion of a 3-portion 1000 g recipe deducts 333.3333 g.
    expect(portionsFromStock(333.3333, 1000, 3)).toBe(1)
    expect(portionsFromStock(333.3332, 1000, 3)).toBe(0)
    expect(portionsFromStock(999.9999, 1000, 3)).toBe(2)
  })
})

describe('GET /product/recipe-availability (cashier)', () => {
  let data = null
  beforeAll(async () => {
    const res = await request(app).get('/product/recipe-availability').set(as())
    expect(res.status).toBe(200)
    data = res.body.data
  })
  const row = (p) => data.products.find((r) => r.productId === p.id)

  test('AC-07 / §8.3: Cappuccino makes 10, limited by susu, though its own stock is 0', () => {
    expect(row(cappuccino)).toMatchObject({ portions: 10, limitingIngredientIds: [susu.id] })
    expect(row(cappuccino).requirements).toEqual(
      expect.arrayContaining([
        { ingredientId: kopi.id, perPortion: 10 },
        { ingredientId: susu.id, perPortion: 100 },
        { ingredientId: gula.id, perPortion: 10 }
      ])
    )
  })

  test('the yield divides the use per portion', () => {
    expect(row(latte)).toMatchObject({ portions: 6, requirements: [{ ingredientId: susu.id, perPortion: 150 }] })
  })

  test('stocked products and recipes that are not active are not listed', () => {
    expect(row(airMineral)).toBeUndefined()
    expect(row(noRecipe)).toBeUndefined()
    expect(row(draftRecipe)).toBeUndefined()
  })

  test('FR-11: the shared ingredient balance is listed once', () => {
    const milk = data.ingredients.filter((i) => i.id === susu.id)
    expect(milk).toEqual([expect.objectContaining({ stock: 1000, baseUnit: 'ml' })])
  })
})

describe('QR menu and QR order placement', () => {
  test('the public menu carries portions only, never the ingredients', async () => {
    const res = await request(app).get(`/order/customer-menu?store=${store.id}`)
    expect(res.status).toBe(200)
    const byId = new Map(res.body.data.products.map((p) => [p.id, p]))
    expect(byId.get(cappuccino.id).availablePortions).toBe(10)
    expect(byId.get(latte.id).availablePortions).toBe(6)
    expect(byId.get(noRecipe.id).availablePortions).toBe(0)
    expect(byId.get(draftRecipe.id).availablePortions).toBe(0)
    expect(byId.get(airMineral.id).availablePortions).toBeNull()
    expect(JSON.stringify(res.body)).not.toContain(susu.name)
  })

  test('AC-09: an order the ingredients cannot make is refused when placed', async () => {
    const before = await db.order.count({ where: { store: store.id } })
    const res = await qrOrder([[cappuccino, 11]])
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'INGREDIENT_STOCK_CONFLICT', products: [cappuccino.id] })
    expect(res.body.message).not.toContain(susu.name)
    expect(await db.order.count({ where: { store: store.id } })).toBe(before)
  })

  test('FR-11: menus sharing an ingredient are checked against one balance', async () => {
    // 5 cappuccino (500 ml) + 4 latte (600 ml) = 1.100 ml > 1.000 ml.
    const res = await qrOrder([[cappuccino, 5], [latte, 4]])
    expect(res.status).toBe(409)
    expect(res.body.products.sort()).toEqual([cappuccino.id, latte.id].sort())
  })

  test('a recipe product without an active recipe cannot be ordered', async () => {
    const res = await qrOrder([[noRecipe, 1]])
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('RECIPE_UNAVAILABLE')
  })

  test('an order that fits is placed', async () => {
    const res = await qrOrder([[cappuccino, 4], [latte, 4]])
    expect(res.status).toBe(201)
  })
})

describe('counter sale keeps refusing a short recipe (blokir)', () => {
  test('selling more than the ingredients make is a 409 with nothing deducted', async () => {
    const res = await request(app)
      .post('/order/create')
      .set(as())
      .send({
        store: store.id,
        items: [{ product: cappuccino.id, quantity: 11 }],
        paymentMethod: 'cash',
        idempotencyKey: unique('avc')
      })
    expect(res.status).toBe(409)
    await susu.reload()
    expect(Number(susu.stock)).toBe(1000)
  })
})

describe('low stock ignores recipe products (BR-03/BR-07)', () => {
  test('a make_to_order product with minStock is never low; a stocked one is', async () => {
    const res = await request(app).get('/stock-history/low-stock').set(as())
    expect(res.status).toBe(200)
    const rows = JSON.stringify(res.body)
    expect(rows).toContain(airMineral.nameProduct)
    expect(rows).not.toContain(cappuccino.nameProduct)
  })

  test('the dashboard count agrees', async () => {
    const res = await request(app).get(`/pos/dashboard/summary?store=${store.id}`).set(as())
    expect(res.status).toBe(200)
    // Products: only the stocked AIR MINERAL (3 ≤ 5); no ingredient is low.
    expect(JSON.stringify(res.body)).toMatch(/"lowStock":1[,}]/)
  })
})
