process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Client note 2026-10-24: History Stok shows ingredients and finished
// products on separate tabs. A recipe sale row carries both `ingredient`
// and the menu `product`, so `itemType` is decided by the ingredient column.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const TAG = `SHIT_${Date.now()}`
let store
let category
let menu
let halus
let mie
let adminUser
let token

const getAll = (query) =>
  request(app)
    .get('/stock-history/get-all')
    .query({ limit: 50, ...query })
    .set('Authorization', `Bearer ${token}`)

const row = (overrides) =>
  db.stock_history.create({
    store: store.id,
    referenceType: 'sale',
    quantityBefore: 10,
    quantityChange: -1,
    quantityAfter: 9,
    ...overrides
  })

let rows
beforeAll(async () => {
  store = await db.location.create({ name: `${TAG}_STORE`, status: 'active' })
  category = await db.category.create({ name: `${TAG}_CAT` })
  menu = await db.product.create({ nameProduct: `${TAG}_MENU`, category: category.id, price: 15000 })
  halus = await db.ingredient.create({ store: store.id, name: `${TAG}_HALUS`, unit: 'pcs', baseUnit: 'pcs' })
  mie = await db.ingredient.create({ store: store.id, name: `${TAG}_MIE`, unit: 'pcs', baseUnit: 'pcs' })
  adminUser = await db.user.create({
    userName: `${TAG}_admin`,
    email: `${TAG}_admin@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'SHIT admin'
  })
  token = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )

  rows = {
    productSale: await row({ product: menu.id }),
    recipeHalus: await row({ product: menu.id, ingredient: halus.id, ingredientName: halus.name, quantityChange: -5 }),
    recipeMie: await row({ product: menu.id, ingredient: mie.id, ingredientName: mie.name }),
    openingMie: await row({
      ingredient: mie.id,
      ingredientName: mie.name,
      referenceType: 'adjustment',
      quantityBefore: 0,
      quantityChange: 100,
      quantityAfter: 100
    })
  }
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: adminUser.id } })
  await db.user.destroy({ where: { id: adminUser.id }, force: true })
  await db.ingredient.destroy({ where: { id: [halus.id, mie.id] }, force: true, paranoid: false })
  await db.product.destroy({ where: { id: menu.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

const ids = (res) => res.body.data.map((r) => r.id).sort((a, b) => a - b)
const idsOf = (...list) => list.map((r) => r.id).sort((a, b) => a - b)

describe('GET /stock-history/get-all itemType', () => {
  test('ingredient: every ingredient row, including recipe-sale rows of a menu', async () => {
    const res = await getAll({ itemType: 'ingredient' })
    expect(res.status).toBe(200)
    expect(ids(res)).toEqual(idsOf(rows.recipeHalus, rows.recipeMie, rows.openingMie))
  })

  test('product: finished-product rows only', async () => {
    const res = await getAll({ itemType: 'product' })
    expect(res.status).toBe(200)
    expect(ids(res)).toEqual(idsOf(rows.productSale))
  })

  test('ingredient + ingredient id narrows to that ingredient', async () => {
    const res = await getAll({ itemType: 'ingredient', ingredient: mie.id })
    expect(ids(res)).toEqual(idsOf(rows.recipeMie, rows.openingMie))
  })

  test('ingredient + product gives the ingredients that menu used', async () => {
    const res = await getAll({ itemType: 'ingredient', product: menu.id })
    expect(ids(res)).toEqual(idsOf(rows.recipeHalus, rows.recipeMie))
  })

  test('no itemType keeps the old behaviour: every row', async () => {
    const res = await getAll({})
    expect(ids(res)).toEqual(idsOf(rows.productSale, rows.recipeHalus, rows.recipeMie, rows.openingMie))
  })

  test('every row names its store', async () => {
    const res = await getAll({ itemType: 'ingredient' })
    expect(res.body.data.map((h) => h.storeData)).toEqual(
      res.body.data.map(() => ({ id: store.id, name: `${TAG}_STORE` }))
    )
  })

  test('an unknown itemType is refused', async () => {
    const res = await getAll({ itemType: 'bundle' })
    expect(res.status).toBe(400)
  })
})
