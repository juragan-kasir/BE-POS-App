process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 4 — Objective B / PROD-ORDER-01.
//
// productionOrder.js's BOM lookups (getById, changeStatus's cancellation
// reversal, and startProduction — the actual stock-deduction path) all
// queried bom_header by productId alone, unlike the identical-purpose
// lookup in order.js's checkout path, which scopes by
// {productId, store, status:'active'}. Since BOM is genuinely store-scoped
// (a product can have a different recipe per store) and a product can have
// both an active and an inactive BOM, startProduction's unscoped
// `findOne` could resolve a DIFFERENT store's BOM, deduct that store's
// ingredient stock via ingredient.findByPk(ingredientId) (no store
// re-check at that point), while logging a stock_history row tagged with
// the STARTED order's own store — genuine cross-store ingredient
// corruption, not just a display bug.

let storeA = null
let storeB = null
let category = null
let product = null
let ingredientA = null
let ingredientB = null
let adminA = null
let tokenA = null
let counter = 0

const nextTag = () => {
  counter += 1
  return `PO_BOM_${Date.now()}_${counter}`
}

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'PROD_BOM_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'PROD_BOM_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'PROD_BOM_CATEGORY' })

  product = await db.product.create({
    nameProduct: 'PROD_BOM_SHARED_PRODUCT',
    category: category.id,
    price: 20000,
    inventoryMode: 'hybrid'
  })
  await db.product_store.create({ product: product.id, store: storeA.id })
  await db.product_store.create({ product: product.id, store: storeB.id })

  ingredientA = await db.ingredient.create({
    store: storeA.id,
    name: 'PROD_BOM_ING_A',
    stock: 1000,
    minStock: 0,
    unit: 'g',
    baseUnit: 'g',
    conversionFactor: 1,
    status: 'active'
  })
  ingredientB = await db.ingredient.create({
    store: storeB.id,
    name: 'PROD_BOM_ING_B',
    stock: 1000,
    minStock: 0,
    unit: 'g',
    baseUnit: 'g',
    conversionFactor: 1,
    status: 'active'
  })

  adminA = await db.user.create({
    userName: 'admin_prod_bom_a',
    email: 'admin_prod_bom_a@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active'
  })
  tokenA = await signSessionToken(
    { id: adminA.id, userName: adminA.userName, roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  await db.productionOrder.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  await db.bom_line.destroy({ where: {}, force: true })
  await db.bom_header.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  await db.product_store.destroy({ where: { product: product?.id }, force: true })
  await db.ingredient.destroy({ where: { id: [ingredientA?.id, ingredientB?.id] }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: adminA?.id }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id] }, force: true })
})

const makeBom = async (store, lines, overrides = {}) => {
  const header = await db.bom_header.create({
    store,
    productId: overrides.productId || product.id,
    name: nextTag(),
    status: 'active',
    ...overrides
  })
  await db.bom_line.bulkCreate(
    lines.map((l) => ({
      bomHeaderId: header.id,
      ingredientId: l.ingredientId,
      qty: l.qty,
      unit: l.unit || 'g'
    }))
  )
  return header
}

describe('PROD-ORDER-01 — Production Order BOM store scoping', () => {
  let order = null

  beforeAll(async () => {
    // Store B's BOM is created FIRST deliberately — an unscoped
    // `bom_header.findOne({where: {productId}})` with no ORDER BY tends to
    // return rows in insertion order, so this ordering is what actually
    // exercises the bug (an unscoped query would resolve Store B's BOM for
    // a Store A production order) rather than coincidentally "passing" by
    // picking whichever row happens to be created first.
    await makeBom(storeB.id, [{ ingredientId: ingredientB.id, qty: 5 }])
    await makeBom(storeA.id, [{ ingredientId: ingredientA.id, qty: 2 }])

    order = await db.productionOrder.create({
      store: storeA.id,
      productionNo: nextTag(),
      productItemId: product.id,
      plannedQty: 1,
      status: 'planned'
    })
  })

  test('starting a Store A production order deducts Store A\'s BOM ingredient, never Store B\'s', async () => {
    const res = await request(app)
      .post(`/production-order/start/${order.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)

    const ingA = await db.ingredient.findByPk(ingredientA.id)
    const ingB = await db.ingredient.findByPk(ingredientB.id)
    expect(Number(ingA.stock)).toBe(998) // 1000 - (2 * 1)
    expect(Number(ingB.stock)).toBe(1000) // untouched — must never see Store B's BOM
  })
})

describe('PROD-ORDER-01 — active vs inactive BOM selection', () => {
  // A separate product from the first describe block's — that block
  // already created an active Store A BOM for `product`, and BOM's
  // duplicate-active-BOM guard lives at the application layer (bom.js's
  // create endpoint), not a DB constraint, so directly inserting a second
  // active bom_header row for the SAME product+store here would make this
  // test's own fixture ambiguous rather than testing anything real.
  let ownProduct = null
  let ingredientActive = null
  let ingredientInactive = null
  let order = null

  beforeAll(async () => {
    ownProduct = await db.product.create({
      nameProduct: 'PROD_BOM_ACTIVE_INACTIVE_PRODUCT',
      category: category.id,
      price: 20000,
      inventoryMode: 'hybrid'
    })
    await db.product_store.create({ product: ownProduct.id, store: storeA.id })

    ingredientActive = await db.ingredient.create({
      store: storeA.id,
      name: 'PROD_BOM_ING_ACTIVE_RECIPE',
      stock: 1000,
      minStock: 0,
      unit: 'g',
      baseUnit: 'g',
      conversionFactor: 1,
      status: 'active'
    })
    ingredientInactive = await db.ingredient.create({
      store: storeA.id,
      name: 'PROD_BOM_ING_INACTIVE_RECIPE',
      stock: 1000,
      minStock: 0,
      unit: 'g',
      baseUnit: 'g',
      conversionFactor: 1,
      status: 'active'
    })

    // Inactive BOM for the same product+store — must never be selected.
    await makeBom(storeA.id, [{ ingredientId: ingredientInactive.id, qty: 7 }], {
      status: 'inactive',
      productId: ownProduct.id
    })
    // The genuinely active one.
    await makeBom(storeA.id, [{ ingredientId: ingredientActive.id, qty: 3 }], {
      productId: ownProduct.id
    })

    order = await db.productionOrder.create({
      store: storeA.id,
      productionNo: nextTag(),
      productItemId: ownProduct.id,
      plannedQty: 1,
      status: 'planned'
    })
  })

  afterAll(async () => {
    await db.stock_history.destroy({
      where: { ingredient: [ingredientActive?.id, ingredientInactive?.id] },
      force: true
    })
    // bom_line.ingredientId's FK is RESTRICT in the live test DB (despite
    // the migration nominally declaring ON DELETE CASCADE) — must delete
    // these lines before the ingredients they reference.
    await db.bom_line.destroy({
      where: { ingredientId: [ingredientActive?.id, ingredientInactive?.id] },
      force: true
    })
    await db.ingredient.destroy({
      where: { id: [ingredientActive?.id, ingredientInactive?.id] },
      force: true
    })
    await db.bom_header.destroy({ where: { productId: ownProduct?.id }, force: true })
    await db.productionOrder.destroy({ where: { productItemId: ownProduct?.id }, force: true })
    await db.product_store.destroy({ where: { product: ownProduct?.id }, force: true })
    await db.product.destroy({ where: { id: ownProduct?.id }, force: true })
  })

  test('starting production resolves the active BOM, not the inactive one', async () => {
    const res = await request(app)
      .post(`/production-order/start/${order.id}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)

    const active = await db.ingredient.findByPk(ingredientActive.id)
    const inactive = await db.ingredient.findByPk(ingredientInactive.id)
    expect(Number(active.stock)).toBe(997) // 1000 - (3 * 1) — the active BOM's line
    expect(Number(inactive.stock)).toBe(1000) // untouched — inactive BOM must never be used
  })
})
