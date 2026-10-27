process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { hybridProducts } = require('../api/service/inventoryLinkService')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BRD "Harga Modal, HPP, Resep/BOM & Stok" phase 4F (G7): the BRD has two
// kinds of product; 'hybrid' (own stock AND recipe deducted on every sale)
// stays on products that already have it but can no longer be chosen. A
// read-only report suggests where each hybrid product should go.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let category = null
let admin = null
let token = null
const productIds = []
const bomIds = []
let ingredient = null
const as = () => ({ Authorization: `Bearer ${token}` })

const makeProduct = async (inventoryMode, extra = {}) => {
  const p = await db.product.create({
    nameProduct: unique('HYB'),
    category: category.id,
    price: 10000,
    inventoryMode,
    status: 'active',
    ...extra
  })
  productIds.push(p.id)
  await db.product_store.create({ product: p.id, store: store.id })
  await db.product_store_stock.create({ product: p.id, store: store.id, stock: 7 })
  return p
}

const addRecipe = async (product) => {
  const bom = await db.bom_header.create({ store: store.id, productId: product.id, name: 'r', totalQty: 1, status: 'active' })
  bomIds.push(bom.id)
  await db.bom_line.create({ bomHeaderId: bom.id, ingredientId: ingredient.id, qty: 1, unit: 'pcs' })
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('HYB_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('HYB_CAT') })
  admin = await db.user.create({
    userName: unique('hyb_admin'),
    email: `${unique('hyb_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken({ id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id }, JWT_SECRET)
  ingredient = await db.ingredient.create({
    store: store.id,
    name: unique('HYB_ING'),
    stock: 100,
    unit: 'pcs',
    baseUnit: 'pcs',
    conversionFactor: 1,
    costPrice: 100,
    status: 'active'
  })
})

afterAll(async () => {
  await db.productionOrder.destroy({ where: { productItemId: productIds }, force: true })
  await db.bom_line.destroy({ where: { bomHeaderId: bomIds }, force: true })
  await db.bom_header.destroy({ where: { id: bomIds }, force: true })
  await db.stock_history.destroy({ where: { product: productIds }, force: true })
  await db.product_store.destroy({ where: { product: productIds }, force: true })
  await db.product_store_stock.destroy({ where: { product: productIds }, force: true })
  await db.product.destroy({ where: { id: productIds }, force: true })
  await db.ingredient.destroy({ where: { id: ingredient?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: admin?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('hybrid can no longer be chosen', () => {
  test('a new product cannot be hybrid', async () => {
    const name = unique('HYB_NEW')
    const res = await request(app)
      .post('/product/add-product')
      .set(as())
      .send({ nameProduct: name, category: category.id, price: 1000, stores: [store.id], inventoryMode: 'hybrid' })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'INVENTORY_MODE_RETIRED', field: 'inventoryMode' })
    expect(await db.product.findOne({ where: { nameProduct: name } })).toBeNull()
  })

  test('another product cannot be switched to hybrid', async () => {
    const product = await makeProduct('stocked')
    const res = await request(app).put('/product/edit-product').set(as()).send({ id: product.id, inventoryMode: 'hybrid' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVENTORY_MODE_RETIRED')
    await product.reload()
    expect(product.inventoryMode).toBe('stocked')
  })

  test('a product that is already hybrid keeps it on any edit, and can leave it', async () => {
    const product = await makeProduct('hybrid')
    const keep = await request(app)
      .put('/product/edit-product')
      .set(as())
      .send({ id: product.id, inventoryMode: 'hybrid', price: 12000 })
    expect(keep.status).toBe(200)
    await product.reload()
    expect(product.inventoryMode).toBe('hybrid')
    expect(product.price).toBe(12000)

    const leave = await request(app).put('/product/edit-product').set(as()).send({ id: product.id, inventoryMode: 'stocked' })
    expect(leave.status).toBe(200)
    await product.reload()
    expect(product.inventoryMode).toBe('stocked')
  })
})

describe('read-only hybrid report', () => {
  let withRecipe = null
  let produced = null
  let bare = null
  let rows = null
  beforeAll(async () => {
    withRecipe = await makeProduct('hybrid')
    await addRecipe(withRecipe)
    produced = await makeProduct('hybrid')
    await addRecipe(produced)
    await db.productionOrder.create({
      store: store.id,
      productionNo: unique('PO'),
      productItemId: produced.id,
      plannedQty: 1,
      producedQty: 0,
      status: 'draft'
    })
    bare = await makeProduct('hybrid')
    rows = await hybridProducts()
  })
  const row = (p) => rows.find((r) => r.productId === p.id)

  test('lists each hybrid product with its stock, recipe outlets and production orders', () => {
    expect(row(withRecipe)).toMatchObject({
      stores: [store.id],
      ownStock: [{ store: store.id, stock: 7 }],
      recipeStores: [store.id],
      productionOrders: 0
    })
    expect(row(produced).productionOrders).toBe(1)
  })

  test('suggests a BRD kind: produced → stocked, recipe everywhere → make_to_order, else stocked', () => {
    expect(row(produced).suggestedMode).toBe('stocked')
    expect(row(withRecipe).suggestedMode).toBe('make_to_order')
    expect(row(bare).suggestedMode).toBe('stocked')
  })

  test('changes nothing', async () => {
    for (const p of [withRecipe, produced, bare]) {
      await p.reload()
      expect(p.inventoryMode).toBe('hybrid')
    }
  })
})
