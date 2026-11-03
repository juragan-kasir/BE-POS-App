process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-07 (product-grade audit 2026-11-02): POST /pos/adjust checked only the
// global product.stock and clamped the outlet row at 0, so removing 150 from
// an outlet holding 100 (global 400) was accepted: outlet 0, global 250, and
// global ≠ Σ outlets. The outlet balance is now the limit.

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA = null
let storeB = null
let category = null
let adminA = null
let superAdmin = null
let adminAToken = null
let superAdminToken = null

const outletStock = async (product, store) =>
  Number((await db.product_store_stock.findOne({ where: { product, store }, raw: true }))?.stock ?? NaN)
const globalStock = async (product) => Number((await db.product.findByPk(product, { raw: true })).stock)
const sumOutlets = async (product) =>
  (await db.product_store_stock.findAll({ where: { product }, raw: true })).reduce((s, r) => s + Number(r.stock), 0)
const historyCount = (product) => db.stock_history.count({ where: { product, referenceType: 'adjustment' } })

// Outlet A 100 + outlet B 300 = global 400, sold at both outlets.
const makeProduct = async ({ stores = 'both' } = {}) => {
  const product = await db.product.create({ nameProduct: 'PGA07_ITEM', category: category.id, price: 5000, stock: 400 })
  const sold = stores === 'both' ? [storeA.id, storeB.id] : [storeB.id]
  for (const s of sold) await db.product_store.create({ product: product.id, store: s })
  await db.product_store_stock.create({ product: product.id, store: storeA.id, stock: 100 })
  await db.product_store_stock.create({ product: product.id, store: storeB.id, stock: 300 })
  return product
}

const adjust = (token, body) => request(app).post('/pos/adjust').set('Authorization', `Bearer ${token}`).send(body)

beforeAll(async () => {
  storeA = await db.location.create({ name: 'PGA07_STORE_A', status: 'active' })
  storeB = await db.location.create({ name: 'PGA07_STORE_B', status: 'active' })
  category = await db.category.create({ name: 'PGA07_CATEGORY' })
  adminA = await db.user.create({
    userName: 'admin_pga07_a',
    email: 'admin_pga07_a@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active'
  })
  superAdmin = await db.user.create({
    userName: 'superadmin_pga07',
    email: 'superadmin_pga07@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active'
  })
  adminAToken = await signSessionToken(
    { id: adminA.id, userName: adminA.userName, roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
  superAdminToken = await signSessionToken(
    { id: superAdmin.id, userName: superAdmin.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
})

afterAll(async () => {
  const ids = (await db.product.findAll({ where: { category: category.id }, attributes: ['id'], raw: true })).map((r) => r.id)
  await db.stock_history.destroy({ where: { product: ids }, force: true })
  await db.product_store_stock.destroy({ where: { product: ids }, force: true })
  await db.product_store.destroy({ where: { product: ids }, force: true })
  await db.product.destroy({ where: { id: ids }, force: true })
  await db.user.destroy({ where: { id: [adminA.id, superAdmin.id] }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: [storeA.id, storeB.id] }, force: true })
})

describe('PGA-07 — POST /pos/adjust is limited by the outlet balance', () => {
  test('removing 150 from an outlet holding 100 (global 400) is refused and changes nothing', async () => {
    const p = await makeProduct()
    const res = await adjust(adminAToken, { productId: p.id, sign: '-', value: 150, reason: 'overdraw' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INSUFFICIENT_STOCK')
    expect(res.body.available).toBe(100)
    expect(await outletStock(p.id, storeA.id)).toBe(100)
    expect(await globalStock(p.id)).toBe(400)
    expect(await historyCount(p.id)).toBe(0)
  })

  test('a removal within the outlet balance moves outlet and global by the same delta', async () => {
    const p = await makeProduct()
    const res = await adjust(adminAToken, { productId: p.id, sign: '-', value: 60, reason: 'pecah' })

    expect(res.status).toBe(200)
    expect(res.body.data.adjustment).toMatchObject({
      oldStock: 400,
      newStock: 340,
      qty: -60,
      store: storeA.id,
      outletStockBefore: 100,
      outletStockAfter: 40
    })
    expect(await outletStock(p.id, storeA.id)).toBe(40)
    expect(await outletStock(p.id, storeB.id)).toBe(300)
    expect(await globalStock(p.id)).toBe(340)
    expect(await sumOutlets(p.id)).toBe(await globalStock(p.id))
  })

  test('removing exactly the outlet balance reaches 0 and keeps global = Σ outlets', async () => {
    const p = await makeProduct()
    const res = await adjust(adminAToken, { productId: p.id, sign: '-', value: 100, reason: 'habis' })

    expect(res.status).toBe(200)
    expect(await outletStock(p.id, storeA.id)).toBe(0)
    expect(await globalStock(p.id)).toBe(300)
    expect(await sumOutlets(p.id)).toBe(300)
  })

  test('an increase adds to the outlet and to global', async () => {
    const p = await makeProduct()
    const res = await adjust(adminAToken, { productId: p.id, sign: '+', value: 25, reason: 'restock' })

    expect(res.status).toBe(200)
    expect(await outletStock(p.id, storeA.id)).toBe(125)
    expect(await globalStock(p.id)).toBe(425)
    expect(await sumOutlets(p.id)).toBe(425)
  })

  test('a product not sold at the adjusting outlet is not found and changes nothing', async () => {
    const p = await makeProduct({ stores: 'B only' })
    const res = await adjust(adminAToken, { productId: p.id, sign: '+', value: 10, reason: 'foreign' })

    expect(res.status).toBe(404)
    expect(await globalStock(p.id)).toBe(400)
    expect(await outletStock(p.id, storeA.id)).toBe(100)
    expect(await historyCount(p.id)).toBe(0)
  })

  test('without an outlet, a product stocked per outlet is refused (STORE_REQUIRED)', async () => {
    const p = await makeProduct()
    const res = await adjust(superAdminToken, { productId: p.id, sign: '-', value: 5, reason: 'no store' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('STORE_REQUIRED')
    expect(await globalStock(p.id)).toBe(400)
  })

  test('the vendor super admin naming an outlet is limited by that outlet', async () => {
    const p = await makeProduct()
    const over = await adjust(superAdminToken, { productId: p.id, sign: '-', value: 301, storeId: storeB.id })
    expect(over.status).toBe(400)
    expect(over.body.available).toBe(300)

    const ok = await adjust(superAdminToken, { productId: p.id, sign: '-', value: 300, storeId: storeB.id })
    expect(ok.status).toBe(200)
    expect(await outletStock(p.id, storeB.id)).toBe(0)
    expect(await globalStock(p.id)).toBe(100)
  })
})
