process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { duplicateInventoryCandidates } = require('../api/service/inventoryLinkService')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BRD "Harga Modal, HPP, Resep/BOM & Stok" phase 3: a finished good sold as
// it is (Le Minerale) takes its stock, cost and minimum from ONE inventory
// item per outlet (BR-01/BR-02, FR-06), and selling it writes one movement
// on that item only (AC-05/AC-06, FR-08). Product inventoryMode
// 'inventory_item'; the link is the outlet's one-line BOM.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let otherStore = null
let category = null
let admin = null
let token = null
const productIds = []
const ingredientIds = []
const as = () => ({ Authorization: `Bearer ${token}` })

let airMineral = null // ingredient: 24 pcs, Rp72.000 per dus of 24 → Rp3.000 per pcs
let foreignItem = null

async function makeIngredient(name, { storeId, stock, minStock = 0, unit = 'pcs', baseUnit = 'pcs', factor = 1, cost = 0 }) {
  const ing = await db.ingredient.create({
    store: storeId,
    name: unique(name),
    stock,
    minStock,
    unit,
    baseUnit,
    conversionFactor: factor,
    costPrice: cost,
    status: 'active'
  })
  ingredientIds.push(ing.id)
  return ing
}

const createLinked = (name, links, extra = {}) =>
  request(app)
    .post('/product/add-product')
    .set(as())
    .send({
      nameProduct: unique(name),
      category: category.id,
      price: 5000,
      status: 'active',
      stores: [store.id],
      inventoryMode: 'inventory_item',
      inventoryLinks: JSON.stringify(links),
      ...extra
    })
    .then((res) => {
      if (res.body?.data?.id) productIds.push(res.body.data.id)
      return res
    })

const linkOf = async (productId) => {
  const bom = await db.bom_header.findOne({
    where: { productId, store: store.id },
    include: [{ model: db.bom_line, as: 'lines' }]
  })
  return bom && { status: bom.status, totalQty: bom.totalQty, lines: bom.lines.map((l) => ({ ingredientId: l.ingredientId, qty: l.qty, unit: l.unit })) }
}

const counterSale = (product, quantity) =>
  request(app)
    .post('/order/create')
    .set(as())
    .send({
      store: store.id,
      items: [{ product: product.id, quantity }],
      paymentMethod: 'cash',
      idempotencyKey: unique('iil')
    })

beforeAll(async () => {
  store = await db.location.create({ name: unique('IIL_STORE'), status: 'active' })
  otherStore = await db.location.create({ name: unique('IIL_OTHER'), status: 'active' })
  category = await db.category.create({ name: unique('IIL_CAT') })
  await db.taxConfig.create({ store: store.id, name: unique('IIL_PPN'), rate: 0, type: 'ppn', status: 'active' })
  admin = await db.user.create({
    userName: unique('iil_admin'),
    email: `${unique('iil_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken({ id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id }, JWT_SECRET)

  airMineral = await makeIngredient('LE MINERALE', { storeId: store.id, stock: 24, minStock: 30, unit: 'dus', factor: 24, cost: 72000 })
  foreignItem = await makeIngredient('LE MINERALE LAIN', { storeId: otherStore.id, stock: 50 })

  const open = await request(app).post('/cash-register/open').set(as()).send({ store: store.id, openingBalance: 0 })
  if (![200, 201].includes(open.status)) throw new Error('register setup failed: ' + JSON.stringify(open.body))
})

afterAll(async () => {
  const stores = [store.id, otherStore.id]
  const orderIds = (await db.order.findAll({ where: { store: stores }, attributes: ['id'] })).map((o) => o.id)
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.stock_history.destroy({ where: { store: stores }, force: true })
  await db.stock_history.destroy({ where: { product: productIds }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.cashRegister.destroy({ where: { store: stores }, force: true })
  await db.productionOrder.destroy({ where: { productItemId: productIds }, force: true })
  const bomIds = (await db.bom_header.findAll({ where: { productId: productIds }, paranoid: false, attributes: ['id'] })).map((b) => b.id)
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
  await db.location.destroy({ where: { id: stores }, force: true })
})

describe('creating a finished good from an inventory item (AC-05, FR-06)', () => {
  let product = null
  beforeAll(async () => {
    const res = await createLinked('LE MINERALE 600ML', [{ store: store.id, ingredientId: airMineral.id }], {
      stock: 99,
      minStock: 7
    })
    expect(res.status).toBe(200)
    product = await db.product.findByPk(res.body.data.id)
  })

  test('no stock or minimum is kept on the product — only the item balance', async () => {
    expect(product.inventoryMode).toBe('inventory_item')
    expect(Number(product.stock)).toBe(0)
    expect(Number(product.minStock)).toBe(0)
    expect(await db.stock_history.count({ where: { product: product.id } })).toBe(0)
  })

  test('the link is the outlet BOM with one line: 1 base unit per sold unit', async () => {
    expect(await linkOf(product.id)).toEqual({
      status: 'active',
      totalQty: 1,
      lines: [{ ingredientId: airMineral.id, qty: 1, unit: 'pcs' }]
    })
  })

  test('FR-02: the product reads stock, minimum and cost from the item', async () => {
    const res = await request(app).get(`/product/get-by-id/${product.id}`).set(as())
    expect(res.status).toBe(200)
    expect(res.body.data.inventoryLinks).toEqual([
      expect.objectContaining({
        store: store.id,
        ingredientId: airMineral.id,
        qty: 1,
        baseUnit: 'pcs',
        stock: 24,
        minStock: 30,
        costPerBaseUnit: 3000,
        unitCost: 3000,
        availableUnits: 24
      })
    ])
  })

  test('HPP is the item cost, status auto', async () => {
    const res = await request(app).get(`/bom/costing/${product.id}`).set(as())
    expect(res.status).toBe(200)
    expect(res.body.data.recipes[0]).toMatchObject({ status: 'auto', hppPerPortion: 3000 })
  })

  test('every outlet selling it needs an item', async () => {
    const res = await createLinked('TANPA ITEM', [])
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVENTORY_LINK_REQUIRED')
  })

  test("an item of another outlet is refused, and a tenant admin cannot link another outlet", async () => {
    const wrongItem = await createLinked('ITEM TOKO LAIN', [{ store: store.id, ingredientId: foreignItem.id }])
    expect(wrongItem.status).toBe(400)
    const wrongStore = await createLinked('TOKO LAIN', [{ store: otherStore.id, ingredientId: foreignItem.id }])
    expect(wrongStore.status).toBe(403)
  })
})

describe('selling a linked finished good (AC-06, BR-09, FR-08)', () => {
  let single = null
  let pack = null
  beforeAll(async () => {
    const a = await createLinked('LE MINERALE ECER', [{ store: store.id, ingredientId: airMineral.id, qty: 1 }])
    // Q6: the same item sold as a pack of 6.
    const b = await createLinked('LE MINERALE PAK 6', [{ store: store.id, ingredientId: airMineral.id, qty: 6 }])
    single = await db.product.findByPk(a.body.data.id)
    pack = await db.product.findByPk(b.body.data.id)
    await airMineral.update({ stock: 24 })
  })

  test('availability is what the item can sell', async () => {
    const res = await request(app).get('/product/recipe-availability').set(as())
    expect(res.status).toBe(200)
    const row = (p) => res.body.data.products.find((r) => r.productId === p.id)
    expect(row(single)).toMatchObject({ portions: 24, limitingIngredientIds: [airMineral.id] })
    expect(row(pack)).toMatchObject({ portions: 4 })
  })

  test('the public menu shows the same, never the item', async () => {
    const res = await request(app).get(`/order/customer-menu?store=${store.id}`)
    expect(res.status).toBe(200)
    const dto = res.body.data.products.find((p) => p.id === pack.id)
    expect(dto).toMatchObject({ availablePortions: 4, effectiveStock: 4, composition: [] })
    expect(JSON.stringify(res.body)).not.toContain(airMineral.name)
  })

  test('one sale = one movement on the item, none on the product', async () => {
    const res = await counterSale(pack, 1)
    expect(res.status).toBe(201)
    await airMineral.reload()
    expect(Number(airMineral.stock)).toBe(18)
    const rows = await db.stock_history.findAll({ where: { ingredient: airMineral.id, referenceType: 'sale' } })
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].quantityChange)).toBe(-6)
    // The item row names the product that used it; no product-stock row.
    expect(rows[0].product).toBe(pack.id)
    expect(await db.stock_history.count({ where: { product: pack.id, ingredient: null } })).toBe(0)
    const order = await db.order.findOne({ where: { store: store.id }, order: [['id', 'DESC']] })
    const line = await db.order_item.findOne({ where: { order: order.id } })
    expect(Number(line.hppSnapshot)).toBe(18000)
  })

  test('selling more than the item holds is refused (blokir)', async () => {
    const res = await counterSale(single, 19)
    expect(res.status).toBe(409)
    await airMineral.reload()
    expect(Number(airMineral.stock)).toBe(18)
  })

  test('low stock: the item is listed, the product is not', async () => {
    const res = await request(app).get('/stock-history/low-stock').set(as())
    expect(res.status).toBe(200)
    const rows = JSON.stringify(res.body)
    expect(rows).toContain(airMineral.name)
    expect(rows).not.toContain(single.nameProduct)
  })
})

describe('no second balance can come back (BR-01)', () => {
  let product = null
  beforeAll(async () => {
    const res = await createLinked('LE MINERALE GUARD', [{ store: store.id, ingredientId: airMineral.id }])
    product = await db.product.findByPk(res.body.data.id)
  })

  test('goods receipt of the product is refused — receive the item', async () => {
    const res = await request(app)
      .post('/goods-receipt/create')
      .set(as())
      .send({ purchaseOrderId: 1, items: [{ product: product.id, qtyReceived: 5 }] })
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ code: 'PRODUCT_USES_INVENTORY_ITEM', products: [product.id] })
  })

  test('stock transfer of the product is refused', async () => {
    const res = await request(app)
      .post('/pos/transfer')
      .set(as())
      .send({ fromStore: store.id, toStore: otherStore.id, items: [{ productId: product.id, qty: 1 }] })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('PRODUCT_USES_INVENTORY_ITEM')
  })

  test('a production order of the product is refused', async () => {
    const res = await request(app)
      .post('/production-order/create')
      .set(as())
      .send({ productItemId: product.id, plannedQty: 1 })
    expect(res.status).toBe(422)
  })

  test('the link is not a recipe to edit on the BOM pages', async () => {
    const bom = await db.bom_header.findOne({ where: { productId: product.id, store: store.id } })
    const edit = await request(app)
      .put(`/bom/edit/${bom.id}`)
      .set(as())
      .send({ lines: [{ ingredientId: airMineral.id, qty: 2, unit: 'pcs' }] })
    expect(edit.status).toBe(409)
    const del = await request(app).delete(`/bom/delete/${bom.id}`).set(as())
    expect(del.status).toBe(409)
    const list = await request(app).get('/bom/get-all?limit=100').set(as())
    expect(list.status).toBe(200)
    expect(list.body.data.map((b) => b.productId)).not.toContain(product.id)
  })
})

describe('linking an existing product (Q7 reconciliation)', () => {
  let product = null
  let item = null
  beforeAll(async () => {
    item = await makeIngredient('RAMBAK', { storeId: store.id, stock: 27, cost: 1500 })
    product = await db.product.create({
      nameProduct: item.name,
      category: category.id,
      price: 2000,
      costPrice: 1500,
      stock: 20,
      minStock: 5,
      inventoryMode: 'stocked',
      status: 'active'
    })
    productIds.push(product.id)
    await db.product_store.create({ product: product.id, store: store.id })
    await db.product_store_stock.create({ product: product.id, store: store.id, stock: 20 })
  })

  test('the read-only report lists the two balances', async () => {
    const rows = await duplicateInventoryCandidates({ store: store.id })
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: product.id, productStock: 20, ingredientId: item.id, ingredientStock: 27 })
      ])
    )
  })

  test('editing to "inventory item" links it and leaves the old product stock untouched', async () => {
    const res = await request(app)
      .put('/product/edit-product')
      .set(as())
      .send({
        id: product.id,
        inventoryMode: 'inventory_item',
        inventoryLinks: JSON.stringify([{ store: store.id, ingredientId: item.id }]),
        stock: 0
      })
    expect(res.status).toBe(200)
    await product.reload()
    expect(product.inventoryMode).toBe('inventory_item')
    expect(Number(product.stock)).toBe(20)
    expect(await db.stock_history.count({ where: { product: product.id } })).toBe(0)
    expect((await linkOf(product.id)).lines).toEqual([{ ingredientId: item.id, qty: 1, unit: 'pcs' }])
    const rows = await duplicateInventoryCandidates({ store: store.id })
    expect(rows.map((r) => r.productId)).not.toContain(product.id)
  })

  test('a later edit without links keeps them', async () => {
    const res = await request(app).put('/product/edit-product').set(as()).send({ id: product.id, price: 2500 })
    expect(res.status).toBe(200)
    expect((await linkOf(product.id)).lines).toHaveLength(1)
  })

  test('stock opname counts the item once; the linked product is not counted again', async () => {
    const create = await request(app)
      .post('/stock-opname/create')
      .set(as())
      .send({
        store: store.id,
        status: 'draft',
        items: [{ product: product.id, namaBarang: item.name, stokAkhirJumlah: 27, stokFisikJumlah: 25, selisihJumlah: -2 }]
      })
    expect(create.status).toBe(201)
    const complete = await request(app)
      .patch(`/stock-opname/status/${create.body.data.id}`)
      .set(as())
      .send({ status: 'completed' })
    expect(complete.status).toBe(200)
    await item.reload()
    await product.reload()
    expect(Number(item.stock)).toBe(25)
    expect(Number(product.stock)).toBe(20)
    expect(await db.stock_history.count({ where: { product: product.id, ingredient: null } })).toBe(0)
    await db.stockOpnameItem.destroy({ where: { stockOpname: create.body.data.id }, force: true })
    await db.stockOpname.destroy({ where: { id: create.body.data.id }, force: true })
  })

  test('a recipe of several ingredients is never silently replaced', async () => {
    const recipe = await db.product.create({
      nameProduct: unique('BAKSO'),
      category: category.id,
      price: 15000,
      inventoryMode: 'make_to_order',
      status: 'active'
    })
    productIds.push(recipe.id)
    await db.product_store.create({ product: recipe.id, store: store.id })
    const bom = await db.bom_header.create({ store: store.id, productId: recipe.id, name: 'r', totalQty: 1, status: 'active' })
    await db.bom_line.bulkCreate([
      { bomHeaderId: bom.id, ingredientId: airMineral.id, qty: 1, unit: 'pcs' },
      { bomHeaderId: bom.id, ingredientId: item.id, qty: 1, unit: 'pcs' }
    ])
    const res = await request(app)
      .put('/product/edit-product')
      .set(as())
      .send({
        id: recipe.id,
        inventoryMode: 'inventory_item',
        inventoryLinks: JSON.stringify([{ store: store.id, ingredientId: item.id }])
      })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('RECIPE_EXISTS')
    await recipe.reload()
    expect(recipe.inventoryMode).toBe('make_to_order')
    expect(await db.bom_line.count({ where: { bomHeaderId: bom.id } })).toBe(2)
  })
})
