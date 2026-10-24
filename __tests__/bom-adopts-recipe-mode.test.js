process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Client note 2026-10-24 (Waroeng Bakso): after a sale, History Stock should
// show the recipe ingredients going down, not the menu product. A product
// keeps the default 'stocked' mode unless changed, so saving an active BOM
// moves it to 'make_to_order' — except when it was produced through a
// production order, when a store selling it has no active BOM yet, or when
// the mode was chosen explicitly (hybrid).
const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const TAG = `BOMRM_${Date.now()}`
let seq = 0
const tag = (label) => `${TAG}_${label}_${++seq}`

const created = { users: [], stores: [], products: [], ingredients: [], categories: [] }
let storeA
let storeB
let category
let adminToken
let adminUser

const http = (method, path, token) => request(app)[method](path).set('Authorization', `Bearer ${token}`)

const makeIngredient = async (overrides = {}) => {
  const ing = await db.ingredient.create({
    store: storeA.id,
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

// A menu product sold at the given stores, still on the default mode.
const makeProduct = async (stores = [storeA.id], overrides = {}) => {
  const product = await db.product.create({
    nameProduct: tag('MENU'),
    category: category.id,
    price: 20000,
    stock: 20,
    inventoryMode: 'stocked',
    ...overrides
  })
  created.products.push(product.id)
  for (const store of stores) {
    await db.product_store.create({ product: product.id, store })
    await db.product_store_stock.create({ product: product.id, store, stock: 20 })
  }
  return product
}

const modeOf = async (product) => (await db.product.findByPk(product.id)).inventoryMode

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
    fullName: 'BOMRM admin'
  })
  created.users.push(adminUser.id)
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: storeA.id },
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
  await db.productionOrder.destroy({ where: { productItemId: created.products }, force: true })
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
  await db.product_store.destroy({ where: { product: created.products }, force: true })
  await db.product.destroy({ where: { id: created.products }, force: true })
  await db.ingredient.destroy({ where: { id: created.ingredients }, force: true, paranoid: false })
  await db.category.destroy({ where: { id: created.categories }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
})

describe('an active BOM makes a stocked menu deduct its ingredients', () => {
  test('the sale then deducts the ingredients, never the menu stock', async () => {
    const halus = await makeIngredient({ name: tag('Bakso Halus') })
    const menu = await makeProduct()

    const res = await http('post', '/bom/add', adminToken).send({
      productId: menu.id,
      lines: [{ ingredientId: halus.id, qty: 5, unit: 'pcs' }]
    })
    expect(res.status).toBe(201)
    expect(res.body.recipeModeAdopted).toBe(true)
    expect(await modeOf(menu)).toBe('make_to_order')

    const sale = await http('post', '/order/create', adminToken).send(withIdempotencyKey({
      store: storeA.id,
      items: [{ product: menu.id, quantity: 2 }],
      paymentMethod: 'cash',
      cashierName: 'Kasir Bakso'
    }))
    expect(sale.status).toBe(201)

    expect(Number((await db.ingredient.findByPk(halus.id)).stock)).toBe(90)
    const storeStock = await db.product_store_stock.findOne({ where: { product: menu.id, store: storeA.id } })
    expect(Number(storeStock.stock)).toBe(20)

    const history = await db.stock_history.findAll({
      where: { referenceType: 'sale', referenceId: sale.body.data.id }
    })
    expect(history.map((h) => [h.ingredient, Number(h.quantityChange)])).toEqual([[halus.id, -10]])

    const audit = await db.auditLog.findOne({
      where: { entity: 'product', entityId: String(menu.id), action: 'update' },
      order: [['id', 'DESC']]
    })
    expect(audit?.description).toMatch(/recipe ingredients/)
  })

  test('a draft BOM leaves the mode; activating it later switches it', async () => {
    const ing = await makeIngredient()
    const menu = await makeProduct()

    const draft = await http('post', '/bom/add', adminToken).send({
      productId: menu.id,
      status: 'draft',
      lines: [{ ingredientId: ing.id, qty: 1, unit: 'pcs' }]
    })
    expect(draft.status).toBe(201)
    expect(draft.body.recipeModeAdopted).toBe(false)
    expect(await modeOf(menu)).toBe('stocked')

    const activated = await http('put', `/bom/edit/${draft.body.data.id}`, adminToken).send({ status: 'active' })
    expect(activated.status).toBe(200)
    expect(activated.body.recipeModeAdopted).toBe(true)
    expect(await modeOf(menu)).toBe('make_to_order')
  })

  test('a store selling the menu without a recipe keeps it stocked', async () => {
    const ing = await makeIngredient()
    const menu = await makeProduct([storeA.id, storeB.id])

    const res = await http('post', '/bom/add', adminToken).send({
      productId: menu.id,
      lines: [{ ingredientId: ing.id, qty: 1, unit: 'pcs' }]
    })
    expect(res.status).toBe(201)
    expect(res.body.recipeModeAdopted).toBe(false)
    expect(await modeOf(menu)).toBe('stocked')
  })

  test('a produced item keeps selling from its own stock', async () => {
    const ing = await makeIngredient()
    const menu = await makeProduct()
    await db.productionOrder.create({
      store: storeA.id,
      productionNo: tag('PO'),
      productItemId: menu.id,
      plannedQty: 10,
      status: 'completed'
    })

    const res = await http('post', '/bom/add', adminToken).send({
      productId: menu.id,
      lines: [{ ingredientId: ing.id, qty: 1, unit: 'pcs' }]
    })
    expect(res.status).toBe(201)
    expect(res.body.recipeModeAdopted).toBe(false)
    expect(await modeOf(menu)).toBe('stocked')
  })

  test('an explicit hybrid choice is kept', async () => {
    const ing = await makeIngredient()
    const menu = await makeProduct([storeA.id], { inventoryMode: 'hybrid' })

    const res = await http('post', '/bom/add', adminToken).send({
      productId: menu.id,
      lines: [{ ingredientId: ing.id, qty: 1, unit: 'pcs' }]
    })
    expect(res.status).toBe(201)
    expect(res.body.recipeModeAdopted).toBe(false)
    expect(await modeOf(menu)).toBe('hybrid')
  })
})
