process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// BOM authoring hardening + the per-recipe stock requirement (bakso): stock is
// kept per ingredient type, each sale deducts what the menu's recipe uses.
//   - a global super_admin must name the BOM's store (a storeless BOM is never
//     found at sale time);
//   - every line: positive whole qty, same-store ingredient, base unit;
//   - create/update are atomic — a refused request writes nothing;
//   - an update only changes what it carries (no silent re-activation).
const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const TAG = `BOMH_${Date.now()}`
let seq = 0
const tag = (label) => `${TAG}_${label}_${++seq}`

const created = { users: [], stores: [], products: [], ingredients: [], categories: [], orders: [] }
let storeA
let storeB
let category
let adminToken
let superToken
let adminUser

const http = (method, path, token) => request(app)[method](path).set('Authorization', `Bearer ${token}`)

const makeIngredient = async (store, overrides = {}) => {
  const ing = await db.ingredient.create({
    store,
    name: tag('ING'),
    stock: 100,
    unit: 'pcs',
    baseUnit: 'pcs',
    costPrice: 1000,
    status: 'active',
    ...overrides
  })
  created.ingredients.push(ing.id)
  return ing
}

const makeProduct = async (overrides = {}) => {
  const product = await db.product.create({
    nameProduct: tag('MENU'),
    category: category.id,
    price: 20000,
    stock: 0,
    inventoryMode: 'make_to_order',
    ...overrides
  })
  created.products.push(product.id)
  return product
}

const bomOf = (productId) =>
  db.bom_header.findOne({ where: { productId }, include: [{ model: db.bom_line, as: 'lines' }] })

const stockOf = async (ingredient) => Number((await db.ingredient.findByPk(ingredient.id)).stock)

beforeAll(async () => {
  storeA = await db.location.create({ name: tag('STORE_A'), status: 'active' })
  storeB = await db.location.create({ name: tag('STORE_B'), status: 'active' })
  created.stores.push(storeA.id, storeB.id)
  category = await db.category.create({ name: tag('CAT') })
  created.categories.push(category.id)

  adminUser = await db.user.create({
    userName: tag('admin'),
    email: `${tag('admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active',
    fullName: 'BOMH admin'
  })
  const superUser = await db.user.create({
    userName: tag('super'),
    email: `${tag('super')}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'BOMH super'
  })
  created.users.push(adminUser.id, superUser.id)
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: superUser.id, userName: superUser.userName, roleType: 'super_admin', store: null },
    JWT_SECRET
  )

  await db.taxConfig.create({ name: tag('PPN'), rate: 11, type: 'ppn', status: 'active', store: storeA.id })
  await db.cashRegister.destroy({ where: { store: storeA.id, status: 'open' }, force: true })
  await db.cashRegister.create({
    store: storeA.id,
    user: adminUser.id,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
})

afterAll(async () => {
  const orders = await db.order.findAll({ where: { store: created.stores }, attributes: ['id'] })
  const orderIds = orders.map((o) => o.id)
  await db.stock_history.destroy({ where: { store: created.stores }, force: true })
  const headers = await db.bom_header.findAll({ where: { productId: created.products }, attributes: ['id'] })
  await db.bom_line.destroy({ where: { bomHeaderId: headers.map((h) => h.id) }, force: true })
  await db.bom_header.destroy({ where: { productId: created.products }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.cashRegister.destroy({ where: { store: created.stores }, force: true })
  await db.taxConfig.destroy({ where: { store: created.stores }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.best_selling.destroy({ where: { productId: created.products }, force: true })
  await db.product_store_stock.destroy({ where: { product: created.products }, force: true })
  await db.product.destroy({ where: { id: created.products }, force: true })
  await db.ingredient.destroy({ where: { id: created.ingredients }, force: true, paranoid: false })
  await db.category.destroy({ where: { id: created.categories }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
})

describe('BOM create — store and line validation', () => {
  test('a global super_admin without a store is refused; nothing written', async () => {
    const ing = await makeIngredient(storeA.id)
    const product = await makeProduct()
    const res = await http('post', '/bom/add', superToken).send({
      productId: product.id,
      lines: [{ ingredientId: ing.id, qty: 5, unit: 'pcs' }]
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/store is required/)
    expect(await bomOf(product.id)).toBeNull()
  })

  test('a global super_admin naming the store creates the BOM in that store', async () => {
    const ing = await makeIngredient(storeA.id)
    const product = await makeProduct()
    const res = await http('post', '/bom/add', superToken).send({
      store: storeA.id,
      productId: product.id,
      lines: [{ ingredientId: ing.id, qty: 5, unit: 'pcs' }]
    })
    expect(res.status).toBe(201)
    const bom = await bomOf(product.id)
    expect(bom.store).toBe(storeA.id)
    expect(bom.lines.map((l) => [l.ingredientId, l.qty])).toEqual([[ing.id, 5]])
  })

  test('an ingredient of another store is refused; nothing written', async () => {
    const foreign = await makeIngredient(storeB.id)
    const product = await makeProduct()
    const res = await http('post', '/bom/add', adminToken).send({
      productId: product.id,
      lines: [{ ingredientId: foreign.id, qty: 1, unit: 'pcs' }]
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/does not belong to this store/)
    expect(await bomOf(product.id)).toBeNull()
  })

  test.each([0, -2, 1.5])('qty %p is refused; nothing written', async (qty) => {
    const ing = await makeIngredient(storeA.id)
    const product = await makeProduct()
    const res = await http('post', '/bom/add', adminToken).send({
      productId: product.id,
      lines: [{ ingredientId: ing.id, qty, unit: 'pcs' }]
    })
    expect(res.status).toBe(400)
    expect(await bomOf(product.id)).toBeNull()
  })

  test('a second BOM for the same product is refused', async () => {
    const ing = await makeIngredient(storeA.id)
    const product = await makeProduct()
    const body = { productId: product.id, lines: [{ ingredientId: ing.id, qty: 1, unit: 'pcs' }] }
    expect((await http('post', '/bom/add', adminToken).send(body)).status).toBe(201)
    const again = await http('post', '/bom/add', adminToken).send(body)
    expect(again.status).toBe(400)
    expect(again.body.message).toBe('BOM already exists for this product')
  })
})

describe('BOM update — atomic, only what the request carries', () => {
  const draftBom = async () => {
    const ing = await makeIngredient(storeA.id)
    const product = await makeProduct()
    const res = await http('post', '/bom/add', adminToken).send({
      productId: product.id,
      name: 'Resep Lama',
      notes: 'awal',
      status: 'draft',
      lines: [{ ingredientId: ing.id, qty: 3, unit: 'pcs' }]
    })
    expect(res.status).toBe(201)
    return { bomId: res.body.data.id, product, ing }
  }

  test('a notes-only edit keeps a draft BOM draft and keeps its name', async () => {
    const { bomId } = await draftBom()
    const res = await http('put', `/bom/edit/${bomId}`, adminToken).send({ notes: 'catatan baru' })
    expect(res.status).toBe(200)
    const bom = await db.bom_header.findByPk(bomId)
    expect(bom).toMatchObject({ status: 'draft', name: 'Resep Lama', notes: 'catatan baru' })
  })

  test('a refused line set leaves header and lines untouched', async () => {
    const { bomId, product, ing } = await draftBom()
    const foreign = await makeIngredient(storeB.id)
    const res = await http('put', `/bom/edit/${bomId}`, adminToken).send({
      name: 'Harus Tidak Tersimpan',
      status: 'active',
      lines: [{ ingredientId: foreign.id, qty: 2, unit: 'pcs' }]
    })
    expect(res.status).toBe(400)
    const bom = await bomOf(product.id)
    expect(bom).toMatchObject({ name: 'Resep Lama', status: 'draft' })
    expect(bom.lines.map((l) => [l.ingredientId, l.qty])).toEqual([[ing.id, 3]])
  })

  test('a valid line set replaces the recipe and refreshes the product composition', async () => {
    const { bomId, product } = await draftBom()
    const halus = await makeIngredient(storeA.id, { name: tag('Bakso Halus') })
    const urat = await makeIngredient(storeA.id, { name: tag('Bakso Urat') })
    const res = await http('put', `/bom/edit/${bomId}`, adminToken).send({
      status: 'active',
      lines: [
        { ingredientId: urat.id, qty: 2, unit: 'pcs' },
        { ingredientId: halus.id, qty: 2, unit: 'pcs' }
      ]
    })
    expect(res.status).toBe(200)
    const bom = await bomOf(product.id)
    expect(bom.status).toBe('active')
    expect(bom.lines.map((l) => [l.ingredientId, l.qty]).sort()).toEqual(
      [[halus.id, 2], [urat.id, 2]].sort()
    )
    const composition = (await db.product.findByPk(product.id)).composition
    expect(composition.map((c) => c.ingredientId).sort()).toEqual([halus.id, urat.id].sort())
  })
})

describe('client requirement — bakso stock per type, deducted by each menu recipe', () => {
  test('5 halus per "Bakso Halus", 2 urat + 2 halus per "Bakso Urat"; telur untouched', async () => {
    const halus = await makeIngredient(storeA.id, { name: tag('Bakso Halus'), stock: 100 })
    const urat = await makeIngredient(storeA.id, { name: tag('Bakso Urat'), stock: 50 })
    const telur = await makeIngredient(storeA.id, { name: tag('Bakso Telur'), stock: 30 })

    // menu products sold by recipe: their own product stock is irrelevant (0)
    const menuHalus = await makeProduct({ nameProduct: tag('Mie Bakso Halus') })
    const menuUrat = await makeProduct({ nameProduct: tag('Mie Bakso Urat') })

    // recipes authored through the API exactly as the owner would
    for (const [product, lines] of [
      [menuHalus, [{ ingredientId: halus.id, qty: 5, unit: 'pcs' }]],
      [
        menuUrat,
        [
          { ingredientId: urat.id, qty: 2, unit: 'pcs' },
          { ingredientId: halus.id, qty: 2, unit: 'pcs' }
        ]
      ]
    ]) {
      const res = await http('post', '/bom/add', adminToken).send({ productId: product.id, lines })
      expect(res.status).toBe(201)
    }

    const sale = await http('post', '/order/create', adminToken).send(withIdempotencyKey({
      store: storeA.id,
      items: [
        { product: menuHalus.id, quantity: 2 },
        { product: menuUrat.id, quantity: 1 }
      ],
      paymentMethod: 'cash',
      cashierName: 'Kasir Bakso'
    }))
    expect(sale.status).toBe(201)

    expect(await stockOf(halus)).toBe(100 - 5 * 2 - 2 * 1) // 88
    expect(await stockOf(urat)).toBe(50 - 2 * 1) // 48
    expect(await stockOf(telur)).toBe(30)
    // product stock of a recipe menu is never touched
    expect(Number((await db.product.findByPk(menuHalus.id)).stock)).toBe(0)

    // one immutable stock_history row per (menu, ingredient) consumption
    const history = await db.stock_history.findAll({
      where: { referenceType: 'sale', referenceId: sale.body.data.id, ingredient: [halus.id, urat.id] }
    })
    expect(history.map((h) => [h.product, h.ingredient, Number(h.quantityChange)]).sort()).toEqual(
      [
        [menuHalus.id, halus.id, -10],
        [menuUrat.id, urat.id, -2],
        [menuUrat.id, halus.id, -2]
      ].sort()
    )
  })

  test('not enough bakso refuses the whole sale with INGREDIENT_STOCK_CONFLICT; nothing deducted', async () => {
    const halus = await makeIngredient(storeA.id, { name: tag('Bakso Halus'), stock: 7 })
    const menu = await makeProduct()
    expect(
      (
        await http('post', '/bom/add', adminToken).send({
          productId: menu.id,
          lines: [{ ingredientId: halus.id, qty: 5, unit: 'pcs' }]
        })
      ).status
    ).toBe(201)

    const sale = await http('post', '/order/create', adminToken).send(withIdempotencyKey({
      store: storeA.id,
      items: [{ product: menu.id, quantity: 2 }],
      paymentMethod: 'cash',
      cashierName: 'Kasir Bakso'
    }))
    expect(sale.status).toBe(409)
    expect(sale.body.code).toBe('INGREDIENT_STOCK_CONFLICT')
    expect(await stockOf(halus)).toBe(7)
  })
})

// BA finding #4 (Waroeng Bakso dummy, 2026-10-17): HPP is priced per BASE
// unit. Bakso halus is bought at Rp25.000 per kg and 1 kg = 25 butir, so one
// butir costs Rp1.000; mie kuning is Rp18.000 per kg and 1 kg = 10 porsi.
// 5 butir + 1 porsi = Rp6.800, not Rp143.000 (5 × 25.000 + 18.000).
describe('HPP per porsi uses the cost of one base unit', () => {
  const draftBom = async () => {
    const ing = await makeIngredient(storeA.id)
    const product = await makeProduct()
    const res = await http('post', '/bom/add', adminToken).send({
      productId: product.id,
      status: 'draft',
      lines: [{ ingredientId: ing.id, qty: 1, unit: 'pcs' }]
    })
    expect(res.status).toBe(201)
    return { bomId: res.body.data.id, product }
  }

  test('5 butir bakso + 1 porsi mie costs Rp6.800 and the composition shows base units', async () => {
    const { bomId, product } = await draftBom()
    await product.update({ price: 15000 })
    const bakso = await makeIngredient(storeA.id, {
      name: tag('Bakso Halus'),
      unit: 'kg',
      baseUnit: 'butir',
      conversionFactor: 25,
      costPrice: 25000
    })
    const mie = await makeIngredient(storeA.id, {
      name: tag('Mie Kuning'),
      unit: 'kg',
      baseUnit: 'porsi',
      conversionFactor: 10,
      costPrice: 18000
    })
    const res = await http('put', `/bom/edit/${bomId}`, adminToken).send({
      status: 'active',
      lines: [
        { ingredientId: bakso.id, qty: 5, unit: 'butir' },
        { ingredientId: mie.id, qty: 1, unit: 'porsi' }
      ]
    })
    expect(res.status).toBe(200)
    const fresh = await db.product.findByPk(product.id)
    expect(Number(fresh.hppPerPorsi)).toBe(6800)
    // 6.800 / 15.000 = 45,33 % food cost
    expect(Number(fresh.foodCostPersen)).toBeCloseTo(45.33, 2)
    const units = Object.fromEntries(fresh.composition.map((c) => [c.ingredientId, c.unit]))
    expect(units).toEqual({ [bakso.id]: 'butir', [mie.id]: 'porsi' })
  })

  test('an ingredient bought and used in the same unit keeps its price', async () => {
    const { bomId, product } = await draftBom()
    const telur = await makeIngredient(storeA.id, { name: tag('Telur'), costPrice: 2500 })
    const res = await http('put', `/bom/edit/${bomId}`, adminToken).send({
      status: 'active',
      lines: [{ ingredientId: telur.id, qty: 2, unit: 'pcs' }]
    })
    expect(res.status).toBe(200)
    expect(Number((await db.product.findByPk(product.id)).hppPerPorsi)).toBe(5000)
  })
})
