process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

let location = null
let category = null
let product = null

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'CHECK_CONSTRAINT_STORE', status: 'active' }))
  category = await db.category.create({ name: 'CHECK_CONSTRAINT_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'CHECK_CONSTRAINT_PRODUCT',
    category: category.id,
    price: 1000,
    stock: 5
  })
})

afterAll(async () => {
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('DB-level CHECK constraints on stock — the last line of defense independent of application code', () => {
  test('product.stock rejects a negative value even via a direct write that bypasses all application-level clamps', async () => {
    await expect(
      db.product.update({ stock: -1 }, { where: { id: product.id } })
    ).rejects.toThrow()

    const unchanged = await db.product.findByPk(product.id)
    expect(Number(unchanged.stock)).toBe(5)
  })

  test('product.stock still allows NULL (unset) — the constraint only rejects negative values', async () => {
    await expect(
      db.product.update({ stock: null }, { where: { id: product.id } })
    ).resolves.toBeDefined()

    const after = await db.product.findByPk(product.id)
    expect(after.stock).toBeNull()

    // restore for a clean afterAll
    await db.product.update({ stock: 5 }, { where: { id: product.id } })
  })

  test('product_store_stock.stock rejects a negative value the same way', async () => {
    const row = await db.product_store_stock.create({
      product: product.id,
      store: location.id,
      stock: 3
    })

    await expect(
      db.product_store_stock.update({ stock: -5 }, { where: { id: row.id } })
    ).rejects.toThrow()

    const unchanged = await db.product_store_stock.findByPk(row.id)
    expect(Number(unchanged.stock)).toBe(3)
  })
})
