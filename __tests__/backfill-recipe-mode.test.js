process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Client note 2026-10-24 (Waroeng Bakso): a menu whose BOM went active before
// saving a BOM switched the mode (BE #265) still deducted its own stock.
// The backfill applies the same rule to those products: dry run by default,
// --apply switches them with a SYSTEM audit row.
const db = require('../db/models')
const { backfillRecipeMode } = require('../api/service/recipeModeService')

const TAG = `BFRM_${Date.now()}`
let seq = 0
const tag = (label) => `${TAG}_${label}_${++seq}`

const created = { stores: [], products: [], ingredients: [], categories: [], boms: [] }
let storeA
let storeB
let category
let ingredient

// A menu sold at `stores`, still on the default mode, with an active BOM
// (one line) at each store in `bomStores`.
const makeMenu = async ({ stores = [storeA.id], bomStores = stores, overrides = {}, withLines = true } = {}) => {
  const product = await db.product.create({
    nameProduct: tag('MENU'),
    category: category.id,
    price: 15000,
    stock: 20,
    inventoryMode: 'stocked',
    ...overrides
  })
  created.products.push(product.id)
  for (const store of stores) await db.product_store.create({ product: product.id, store })
  for (const store of bomStores) {
    const bom = await db.bom_header.create({ store, productId: product.id, name: tag('BOM'), status: 'active' })
    created.boms.push(bom.id)
    if (withLines) await db.bom_line.create({ bomHeaderId: bom.id, ingredientId: ingredient.id, qty: 1, unit: 'pcs' })
  }
  return product
}

const modeOf = async (product) => (await db.product.findByPk(product.id)).inventoryMode
const run = (apply) => backfillRecipeMode({ apply, productIds: created.products })
const ids = (rows) => rows.map((r) => r.id)

beforeAll(async () => {
  storeA = await db.location.create({ name: tag('STORE_A'), status: 'active' })
  storeB = await db.location.create({ name: tag('STORE_B'), status: 'active' })
  created.stores.push(storeA.id, storeB.id)
  category = await db.category.create({ name: tag('CAT') })
  created.categories.push(category.id)
  ingredient = await db.ingredient.create({
    store: storeA.id,
    name: tag('ING'),
    stock: 100,
    unit: 'pcs',
    baseUnit: 'pcs',
    costPrice: 1000,
    status: 'active'
  })
  created.ingredients.push(ingredient.id)
})

afterAll(async () => {
  await db.bom_line.destroy({ where: { bomHeaderId: created.boms }, force: true })
  await db.bom_header.destroy({ where: { id: created.boms }, force: true })
  await db.productionOrder.destroy({ where: { productItemId: created.products }, force: true })
  await db.product_store.destroy({ where: { product: created.products }, force: true })
  await db.product.destroy({ where: { id: created.products }, force: true })
  await db.ingredient.destroy({ where: { id: created.ingredients }, force: true, paranoid: false })
  await db.category.destroy({ where: { id: created.categories }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
})

test('a dry run lists the menu and changes nothing; --apply switches it with an audit row', async () => {
  const menu = await makeMenu()

  const dry = await run(false)
  expect(ids(dry.switched)).toContain(menu.id)
  expect(await modeOf(menu)).toBe('stocked')

  const applied = await run(true)
  expect(ids(applied.switched)).toContain(menu.id)
  expect(await modeOf(menu)).toBe('make_to_order')

  const audit = await db.auditLog.findOne({
    where: { entity: 'product', entityId: String(menu.id), action: 'update' },
    order: [['id', 'DESC']]
  })
  expect(audit?.actorType).toBe('SYSTEM')
  expect(audit?.newValues).toEqual({ inventoryMode: 'make_to_order' })

  // a switched product is no longer a candidate
  expect(ids((await run(true)).switched)).not.toContain(menu.id)
})

test('the same exceptions as saving a BOM keep a menu stocked', async () => {
  const partial = await makeMenu({ stores: [storeA.id, storeB.id], bomStores: [storeA.id] })
  const produced = await makeMenu()
  await db.productionOrder.create({
    store: storeA.id,
    productionNo: tag('PO'),
    productItemId: produced.id,
    plannedQty: 10,
    status: 'completed'
  })
  const hybrid = await makeMenu({ overrides: { inventoryMode: 'hybrid' } })
  const empty = await makeMenu({ withLines: false })

  const { switched, skipped } = await run(true)
  for (const p of [partial, produced, hybrid, empty]) expect(ids(switched)).not.toContain(p.id)
  const reasonOf = (p) => skipped.find((r) => r.id === p.id)
  expect(reasonOf(partial)).toMatchObject({ reason: 'store_without_bom', missingStores: [storeB.id] })
  expect(reasonOf(produced)?.reason).toBe('production_order')

  expect(await modeOf(partial)).toBe('stocked')
  expect(await modeOf(produced)).toBe('stocked')
  expect(await modeOf(hybrid)).toBe('hybrid')
  expect(await modeOf(empty)).toBe('stocked')
})
