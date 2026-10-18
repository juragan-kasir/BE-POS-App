process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BA finding #3 (Waroeng Bakso dummy, 2026-10-17): the product form kept its
// own manual composition next to the BOM, and a product save overwrote the
// BOM's recipe snapshot. The BOM is now the only writer of
// product.composition; product create and edit leave it alone.

const TAG = `PCOMP_${Date.now()}`
let location = null
let category = null
let adminToken = null
let admin = null

const BOM_SNAPSHOT = [{ ingredientId: 1, name: 'Bakso Halus', qty: 5, unit: 'butir' }]

beforeAll(async () => {
  location = await db.location.create({ name: `${TAG}_STORE`, status: 'active' })
  category = await db.category.create({ name: `${TAG}_CAT` })
  admin = await db.user.create({
    userName: `${TAG}_admin`,
    email: `${TAG}_admin@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  const ids = (await db.product.findAll({ where: { category: category.id } })).map((p) => p.id)
  await db.stock_history.destroy({ where: { product: ids }, force: true })
  await db.product_store_stock.destroy({ where: { product: ids }, force: true })
  await db.product_store.destroy({ where: { product: ids }, force: true })
  await db.product.destroy({ where: { id: ids }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: admin?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('product.composition is owned by the BOM', () => {
  test('creating a product ignores a manual composition', async () => {
    const res = await request(app)
      .post('/product/add-product')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('nameProduct', `${TAG}_NEW`)
      .field('category', String(category.id))
      .field('price', '15000')
      .field('stores', JSON.stringify([location.id]))
      .field('status', 'active')
      .field('composition', JSON.stringify([{ name: 'Manual', qty: 1, unit: 'kg' }]))
    expect(res.status).toBe(200)
    const product = await db.product.findByPk(res.body.data.id)
    expect(product.composition).toEqual([])
  })

  test('editing a product keeps the BOM recipe, with or without a manual composition', async () => {
    const product = await db.product.create({
      nameProduct: `${TAG}_EDIT`,
      category: category.id,
      price: 15000,
      composition: BOM_SNAPSHOT
    })
    await db.product_store.create({ product: product.id, store: location.id })

    const withManual = await request(app)
      .put('/product/edit-product')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        id: product.id,
        nameProduct: `${TAG}_EDIT`,
        price: 16000,
        composition: [{ name: 'Manual', qty: 1, unit: 'kg' }]
      })
    expect(withManual.status).toBe(200)
    let fresh = await db.product.findByPk(product.id)
    expect(Number(fresh.price)).toBe(16000)
    expect(fresh.composition).toEqual(BOM_SNAPSHOT)

    const without = await request(app)
      .put('/product/edit-product')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: product.id, nameProduct: `${TAG}_EDIT`, price: 17000 })
    expect(without.status).toBe(200)
    fresh = await db.product.findByPk(product.id)
    expect(Number(fresh.price)).toBe(17000)
    expect(fresh.composition).toEqual(BOM_SNAPSHOT)
  })
})
