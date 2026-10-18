process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BA finding #2 (Waroeng Bakso dummy, 2026-10-17): a product created with an
// initial stock but no store assignment ("Semua Toko") stranded the number:
// product.stock kept 100, but every outlet read its product_store_stock row —
// 0 without one — so the outlet list showed 0 and the sale was refused, while
// the edit form still showed 100. With per-outlet stock authoritative (DR-14,
// BA gap 027) an initial stock needs at least one outlet to live in.

const TAG = `PSTOCK_${Date.now()}`
let store = null
let category = null
let token = null
let user = null

const feCreate = (name, fields) => {
  let req = request(app)
    .post('/product/add-product')
    .set('Authorization', `Bearer ${token}`)
    .field('nameProduct', name)
    .field('category', String(category.id))
    .field('price', '15000')
    .field('status', 'active')
  Object.entries(fields).forEach(([k, v]) => {
    req = req.field(k, v)
  })
  return req
}

beforeAll(async () => {
  store = await db.location.create({ name: `${TAG}_STORE`, status: 'active' })
  category = await db.category.create({ name: `${TAG}_CAT` })
  user = await db.user.create({
    userName: `${TAG}_admin`,
    email: `${TAG}_admin@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken(
    { id: user.id, userName: user.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  const ids = (await db.product.findAll({ where: { category: category.id } })).map((p) => p.id)
  await db.stock_history.destroy({ where: { product: ids }, force: true })
  await db.product_store_stock.destroy({ where: { product: ids }, force: true })
  await db.product_store.destroy({ where: { product: ids }, force: true })
  await db.product.destroy({ where: { id: ids }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.user.destroy({ where: { id: user.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

describe('initial stock needs a store (BA finding #2)', () => {
  test('the FE "Semua Toko" encoding (stores="") with stock is rejected, nothing is saved', async () => {
    const name = `${TAG}_ALLSTORE_STOCK`
    const res = await feCreate(name, { stores: '', stock: '100' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('STOCK_REQUIRES_STORE')
    const saved = await db.product.findOne({ where: { nameProduct: name } })
    expect(saved).toBeNull()
  })

  test('an API caller omitting stores with stock is rejected too', async () => {
    const name = `${TAG}_NOSTORES_STOCK`
    const res = await request(app)
      .post('/product/add-product')
      .set('Authorization', `Bearer ${token}`)
      .send({ nameProduct: name, category: category.id, price: 15000, stock: 100 })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('STOCK_REQUIRES_STORE')
    const saved = await db.product.findOne({ where: { nameProduct: name } })
    expect(saved).toBeNull()
  })

  test('hybrid (stock is still used) is rejected the same way', async () => {
    const res = await feCreate(`${TAG}_HYBRID`, {
      stores: '',
      stock: '100',
      inventoryMode: 'hybrid'
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('STOCK_REQUIRES_STORE')
  })

  test('a "Semua Toko" product with no initial stock still saves (global catalog)', async () => {
    const res = await feCreate(`${TAG}_CATALOG`, { stores: '', stock: '0' })
    expect(res.status).toBe(200)
    const id = res.body.data.id
    const shadow = await db.product_store_stock.findAll({ where: { product: id }, raw: true })
    expect(shadow.length).toBe(0)
  })

  test('make_to_order ignores product stock — still creatable without stores', async () => {
    // BA finding #2 product type where product stock is unused: the recipe's
    // ingredients are deducted instead, so a stock value here is harmless.
    const res = await feCreate(`${TAG}_MTO`, {
      stores: '',
      stock: '100',
      inventoryMode: 'make_to_order'
    })
    expect(res.status).toBe(200)
  })

  test('stock with a specific store still allocates to that outlet (regression)', async () => {
    const res = await feCreate(`${TAG}_STORED`, {
      stores: JSON.stringify([store.id]),
      stock: '100'
    })
    expect(res.status).toBe(200)
    const id = res.body.data.id
    const shadow = await db.product_store_stock.findAll({ where: { product: id }, raw: true })
    expect(shadow.length).toBe(1)
    expect(Number(shadow[0].stock)).toBe(100)

    const scoped = await request(app)
      .get(`/product/get-product-all?store=${store.id}&search=${TAG}_STORED`)
      .set('Authorization', `Bearer ${token}`)
    const row = (scoped.body.data || []).find((p) => p.id === id)
    expect(row).toBeDefined()
    expect(Number(row.stock)).toBe(100)
  })
})
